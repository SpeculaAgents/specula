// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPonsV2BondingCurve, IPonsV2FeeEscrow, IPonsV2LaunchFactory} from "./interfaces/IPons.sol";

interface IBurnableToken {
    function balanceOf(address who) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burn(uint256 value) external;
}

/// @title SpeculaSplitter
/// @notice The address $SPECULA's trading fees are paid to on Pons. Everything that arrives is divided two ways, in
///         shares fixed in the code: the team wallet, and the buyback wallet, which buys $SPECULA back and burns it.
///         Nobody can change the shares. Each wallet can hand its own share of future splits to another address, in
///         two steps (it proposes, the new address accepts); nothing else can change.
///
///         The deployer names the token once after the launch (setToken), and only a token that Pons records with
///         its fees paid to this contract, an ETH pair, the 3% creator tax and buyback off is accepted.
/// @dev Pons never pushes fees: they sit on the bonding curve, a sweep moves them into Pons' fee escrow, and the
///      escrow keeps a ledger. sweep() does both steps and splits, claim() does the escrow half, and ETH sent straight
///      here is split by distribute(). Anyone may call all three.
///
///      The team share is rounded down and the buyback share is the rest, so the two always add up to what came in.
///      A wallet that refuses its ETH does not stop the other: its share is written down as pending under its name
///      and waits for retry(), or for that wallet to collect it with withdrawPending().
///
///      $SPECULA that reaches this contract (an escrow token credit, or a plain transfer) is never split: burnTokens()
///      burns all of it, and the supply must really fall.
contract SpeculaSplitter {
    uint16 public constant BPS = 10_000;
    uint16 public constant TEAM_BPS = 7_000;
    uint16 public constant BUYBACK_BPS = 3_000;
    uint16 public constant CREATOR_TAX_BPS = 300;
    /// @dev A wallet can carry code these days; a bounded push keeps such code from eating the gas of a split.
    uint256 internal constant WALLET_PUSH_GAS = 50_000;

    IPonsV2LaunchFactory public immutable factory;
    IPonsV2FeeEscrow public immutable escrow;
    /// @notice The deploying wallet. Its one power, used once: naming the token.
    address public immutable setter;

    address payable public team;
    address payable public buyback;
    address payable public proposedTeam;
    address payable public proposedBuyback;
    IBurnableToken public token;

    /// @notice Shares that were refused when they were split, by the wallet they were split for. Never split again.
    mapping(address => uint256) public pendingOf;
    uint256 public pending;

    uint256 public totalSplit;
    uint256 public totalToTeam;
    uint256 public totalToBuyback;
    uint256 public totalTokensBurned;

    uint256 private _locked = 1;

    event TokenSet(address indexed token);
    event Split(uint256 amount, uint256 toTeam, uint256 toBuyback, bool teamPushed, bool buybackPushed);
    event PendingDelivered(address indexed to, uint256 amount);
    event TokensBurned(uint256 amount);
    event PayeeProposed(bool indexed isTeam, address indexed current, address indexed proposed);
    event PayeeProposalCancelled(bool indexed isTeam, address indexed current, address indexed proposed);
    event PayeeChanged(bool indexed isTeam, address indexed previous, address indexed current);

    error ZeroAddress();
    error BadWallets();
    error NotSetter();
    error TokenAlreadySet();
    error TokenNotSet();
    error NotPonsLaunch();
    error WrongFeeRecipient(address recipient);
    error NotEthPair();
    error WrongCreatorTax(uint16 bps);
    error BuybackEnabled();
    error LaunchRescued();
    error NotAllowed();
    error NothingPending();
    error NothingProposed();
    error PushFailed();
    error SupplyDidNotFall();
    error Reentered();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentered();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address payable team_, address payable buyback_, IPonsV2LaunchFactory factory_) {
        if (team_ == address(0) || buyback_ == address(0) || address(factory_) == address(0)) revert ZeroAddress();
        if (team_ == buyback_ || team_ == address(this) || buyback_ == address(this)) revert BadWallets();
        IPonsV2FeeEscrow escrow_ = IPonsV2FeeEscrow(factory_.feeEscrow());
        if (address(escrow_) == address(0)) revert ZeroAddress();
        if (team_ == address(escrow_) || buyback_ == address(escrow_)) revert BadWallets();
        setter = msg.sender;
        team = team_;
        buyback = buyback_;
        factory = factory_;
        escrow = escrow_;
    }

    receive() external payable {}

    /// @notice The deployer only, once. Everything about the launch is read back from Pons and must be exactly what
    ///         this contract splits for, or nothing is set.
    function setToken(address token_) external nonReentrant {
        if (msg.sender != setter) revert NotSetter();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (token_ == address(0)) revert ZeroAddress();
        IPonsV2LaunchFactory.LaunchedToken memory info = factory.getLaunchedToken(token_);
        if (!info.exists || info.token != token_) revert NotPonsLaunch();
        if (info.creatorFeeRecipient != address(this)) revert WrongFeeRecipient(info.creatorFeeRecipient);
        if (info.pairToken != address(0)) revert NotEthPair();
        if (info.creatorTaxBps != CREATOR_TAX_BPS) revert WrongCreatorTax(info.creatorTaxBps);
        if (info.buybackEnabled) revert BuybackEnabled();
        if (info.phase == IPonsV2LaunchFactory.GraduationPhase.Rescued) revert LaunchRescued();
        token = IBurnableToken(token_);
        emit TokenSet(token_);
    }

    /// @notice Release the fees still on the bonding curve into Pons' escrow, claim what the escrow holds for this
    ///         contract, and split it. Anyone may call it.
    /// @dev Only the fee recipient (this contract) or Pons' operator may release a curve's fees, so the release has
    ///      to be called from here. Buyback is off for the token, so the release swaps nothing. It is best effort:
    ///      it reverts with nothing on the curve, and after graduation Pons' operator releases the pool's fees.
    function sweep() external nonReentrant returns (uint256 amount) {
        address c = curve();
        if (c != address(0)) {
            try IPonsV2BondingCurve(c).sweepFees(0) {} catch {}
        }
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Claim what the escrow holds for this contract and split it.
    function claim() external nonReentrant returns (uint256 amount) {
        if (escrow.balanceOf(address(this)) > 0) escrow.claim();
        amount = _distribute();
    }

    /// @notice Split whatever ETH is here and has not been split yet.
    function distribute() external nonReentrant returns (uint256 amount) {
        amount = _distribute();
    }

    /// @notice Burn every $SPECULA here, after claiming any the escrow holds for this contract. Anyone may call it.
    function burnTokens() external nonReentrant returns (uint256 amount) {
        IBurnableToken t = token;
        if (address(t) == address(0)) revert TokenNotSet();
        if (escrow.balanceOfToken(address(this), address(t)) > 0) escrow.claimToken(address(t));
        amount = t.balanceOf(address(this));
        if (amount == 0) return 0;
        uint256 supplyBefore = t.totalSupply();
        t.burn(amount);
        if (supplyBefore - t.totalSupply() != amount) revert SupplyDidNotFall();
        totalTokensBurned += amount;
        emit TokensBurned(amount);
    }

    /// @notice The token's bonding curve while this contract can still release its fees: zero before the token is
    ///         set and from graduation on.
    function curve() public view returns (address) {
        address t = address(token);
        if (t == address(0)) return address(0);
        try factory.getLaunchedToken(t) returns (IPonsV2LaunchFactory.LaunchedToken memory info) {
            if (info.exists && info.phase == IPonsV2LaunchFactory.GraduationPhase.NotGraduated) return info.curve;
        } catch {}
        return address(0);
    }

    /// @notice ETH here that has arrived and not been split yet.
    function unsplit() public view returns (uint256) {
        return address(this).balance - pending;
    }

    /// @notice Deliver the refused shares of the two current wallets. Anyone may call it. A share refused again
    ///         simply stays pending.
    function retry() external nonReentrant {
        _retry(team);
        _retry(buyback);
    }

    /// @notice A wallet, current or former, collects its own refused share to an address it names.
    function withdrawPending(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 a = pendingOf[msg.sender];
        if (a == 0) revert NothingPending();
        pendingOf[msg.sender] = 0;
        pending -= a;
        (bool ok,) = to.call{value: a}("");
        if (!ok) revert PushFailed();
        emit PendingDelivered(to, a);
    }

    /// @notice Step one of handing a share on: the wallet that receives it names the next address. Nothing changes
    ///         until that address accepts. A new proposal replaces the one before.
    function proposePayee(address payable next) external nonReentrant {
        if (next == address(0)) revert ZeroAddress();
        if (next == team || next == buyback || next == address(this) || next == address(escrow)) revert BadWallets();
        if (msg.sender == team) {
            proposedTeam = next;
            emit PayeeProposed(true, msg.sender, next);
        } else if (msg.sender == buyback) {
            proposedBuyback = next;
            emit PayeeProposed(false, msg.sender, next);
        } else {
            revert NotAllowed();
        }
    }

    /// @notice The wallet withdraws its proposal before it is accepted.
    function cancelPayee() external nonReentrant {
        if (msg.sender == team) {
            address payable p = proposedTeam;
            if (p == address(0)) revert NothingProposed();
            proposedTeam = payable(address(0));
            emit PayeeProposalCancelled(true, msg.sender, p);
        } else if (msg.sender == buyback) {
            address payable p = proposedBuyback;
            if (p == address(0)) revert NothingProposed();
            proposedBuyback = payable(address(0));
            emit PayeeProposalCancelled(false, msg.sender, p);
        } else {
            revert NotAllowed();
        }
    }

    /// @notice Step two: the proposed address accepts, and from this call on that share of every split is paid to
    ///         it. What was split before stays the previous wallet's.
    function acceptPayee() external nonReentrant {
        if (msg.sender == address(0)) revert NothingProposed();
        if (msg.sender == proposedTeam) {
            if (msg.sender == buyback) revert BadWallets();
            address payable previous = team;
            team = proposedTeam;
            proposedTeam = payable(address(0));
            emit PayeeChanged(true, previous, team);
        } else if (msg.sender == proposedBuyback) {
            if (msg.sender == team) revert BadWallets();
            address payable previous = buyback;
            buyback = proposedBuyback;
            proposedBuyback = payable(address(0));
            emit PayeeChanged(false, previous, buyback);
        } else {
            revert NothingProposed();
        }
    }

    function _retry(address payable w) internal {
        uint256 a = pendingOf[w];
        if (a == 0) return;
        pendingOf[w] = 0;
        pending -= a;
        if (_pushCapped(w, a)) {
            emit PendingDelivered(w, a);
        } else {
            pendingOf[w] = a;
            pending += a;
        }
    }

    /// @dev A push with a fixed amount of gas that ignores whatever the receiver returns.
    function _pushCapped(address to, uint256 value) internal returns (bool ok) {
        uint256 gasCap = WALLET_PUSH_GAS;
        assembly ("memory-safe") {
            ok := call(gasCap, to, value, 0, 0, 0, 0)
        }
    }

    function _distribute() internal returns (uint256 amount) {
        amount = unsplit();
        if (amount == 0) return 0;
        uint256 toTeam = (amount * TEAM_BPS) / BPS;
        uint256 toBuyback = amount - toTeam;
        totalSplit += amount;
        totalToTeam += toTeam;
        totalToBuyback += toBuyback;

        address payable t = team;
        address payable b = buyback;
        bool okT = toTeam == 0 || _pushCapped(t, toTeam);
        if (!okT) {
            pending += toTeam;
            pendingOf[t] += toTeam;
        }
        bool okB = toBuyback == 0 || _pushCapped(b, toBuyback);
        if (!okB) {
            pending += toBuyback;
            pendingOf[b] += toBuyback;
        }
        emit Split(amount, toTeam, toBuyback, okT, okB);
    }
}
