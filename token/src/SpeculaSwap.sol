// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPonsV2BondingCurve, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "./interfaces/IPoolManager.sol";

interface IERC20Balance {
    function balanceOf(address who) external view returns (uint256);
}

/// @title SpeculaSwap
/// @notice A plain ETH -> token buy for a Pons launch, on the bonding curve or, after graduation, in its Uniswap v4
///         pool. The tokens go to the recipient the caller names and any ETH that was not swapped goes back to the
///         caller in the same transaction. It holds nothing between calls and has no owner and no fee.
/// @dev In the pool the swap carries a hard price limit: the sqrt price may move at most 1% (about 2% in price), so a
///      buy can never be pushed far by thin or just-in-time liquidity. If the limit stops it early, only the ETH
///      actually swapped is spent and the rest comes back. `minOut` is scaled to the ETH really spent.
contract SpeculaSwap is IUnlockCallback {
    uint16 internal constant BPS = 10_000;
    uint16 internal constant LIMIT_BPS = 100;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint256 internal constant POOLS_SLOT = 6; // v4-core StateLibrary

    IPonsV2LaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;
    address public immutable hook;

    uint256 private _locked = 1;

    event Bought(address indexed token, address indexed recipient, uint256 ethIn, uint256 tokensOut, bool viaCurve);

    error MarketClosed();
    error NotPonsLaunch();
    error NotPoolManager();
    error Slippage();
    error Overcharged();
    error RefundFailed();
    error Reentered();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IPonsV2LaunchFactory factory_) {
        factory = factory_;
        poolManager = IPoolManager(factory_.poolManager());
        hook = factory_.memeHook();
    }

    /// @dev Only the curve's refund and the pool manager's change arrive here, both inside buy().
    receive() external payable {
        if (_locked != 2) revert Reentered();
    }

    /// @notice Buy `token` with all the ETH sent, for `recipient`. Reverts unless at least `minOut` scaled to the ETH
    ///         really spent arrives.
    function buy(address token, uint256 minOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 ethIn, uint256 tokensOut)
    {
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token);
        if (!info.exists || info.token != token || info.pairToken != address(0)) revert NotPonsLaunch();
        uint256 value = msg.value;
        uint256 balBefore = address(this).balance - value;
        uint256 tokensBefore = IERC20Balance(token).balanceOf(recipient);
        bool viaCurve;
        if (info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) {
            if (IPonsV2BondingCurve(info.curve).readyToGraduate()) revert MarketClosed();
            viaCurve = true;
            IPonsV2BondingCurve(info.curve).buy{value: value}(value, 0, recipient);
        } else if (info.phase == IPonsV2LaunchFactory.GraduationPhase.PoolCreated) {
            _poolBuy(PoolKey(address(0), token, info.poolFee, info.tickSpacing, hook), value, recipient);
        } else {
            revert MarketClosed();
        }
        uint256 left = address(this).balance - balBefore;
        ethIn = value - left;
        if (ethIn > value) revert Overcharged();
        tokensOut = IERC20Balance(token).balanceOf(recipient) - tokensBefore;
        if (tokensOut == 0 || (value > 0 && (minOut * ethIn) / value > tokensOut)) revert Slippage();
        if (left > 0) {
            (bool ok,) = msg.sender.call{value: left}("");
            if (!ok) revert RefundFailed();
        }
        emit Bought(token, recipient, ethIn, tokensOut, viaCurve);
    }

    function _poolBuy(PoolKey memory key, uint256 value, address recipient) internal {
        bytes32 poolId = keccak256(abi.encode(key));
        uint160 sqrtP = uint160(uint256(poolManager.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)))));
        if (sqrtP == 0) revert MarketClosed();
        uint256 limit = (uint256(sqrtP) * BPS) / (BPS + LIMIT_BPS);
        uint160 priceLimit = limit > MIN_SQRT_PRICE ? uint160(limit) : MIN_SQRT_PRICE + 1;
        poolManager.unlock(abi.encode(key, value, priceLimit, recipient));
    }

    /// @dev Uniswap v4: runs inside poolManager.unlock. ETH is currency0 (address 0), so zeroForOne.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 ethIn, uint160 limit, address recipient) =
            abi.decode(data, (PoolKey, uint256, uint160, address));
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: limit});
        int256 delta = poolManager.swap(key, p, "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        if (amount0 >= 0 || amount1 <= 0) revert Slippage();
        uint256 owe = uint256(uint128(-amount0));
        if (owe > ethIn) revert Overcharged();
        poolManager.settle{value: owe}();
        poolManager.take(key.currency1, recipient, uint256(uint128(amount1)));
        return "";
    }
}
