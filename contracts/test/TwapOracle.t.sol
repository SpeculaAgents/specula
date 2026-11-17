// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpeculaTwapOracle} from "../src/SpeculaTwapOracle.sol";
import {Sig} from "../src/Sig.sol";

/// A contract that uses the oracle the way a consumer should: it asks for a price no older than it can accept.
contract Lender {
    SpeculaTwapOracle immutable oracle;

    constructor(SpeculaTwapOracle o) {
        oracle = o;
    }

    /// Value of `amount` whole-token units (18 decimals) in the quote asset, from a price at most ten minutes old.
    function valueOf(address token, uint256 amount) external view returns (uint256) {
        (uint256 price,) = oracle.read(token, 10 minutes);
        return (amount * price) / 1e18;
    }
}

contract TwapOracleTest is Test {
    SpeculaTwapOracle oracle;
    Lender lender;
    uint256 enginePk = 0xE791E;
    address engine;
    address token = address(0x70CE);
    address other = address(0x70CF);
    uint32 constant WINDOW = 1800;

    function setUp() public {
        engine = vm.addr(enginePk);
        oracle = new SpeculaTwapOracle(engine, WINDOW);
        lender = new Lender(oracle);
        vm.warp(1_800_000_000);
    }

    function _sign(uint256 key, address t, uint256 price, uint64 ts, uint32 window, bool thin) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, Sig.personal(oracle.updateHash(t, price, ts, window, thin)));
        return abi.encodePacked(r, s, v);
    }

    /// Sign an update with `key`, submit it, and require the contract to refuse it with `sel`.
    function _refuse(bytes4 sel, uint256 key, address t, uint256 price, uint64 ts, uint32 window, bool thin) internal {
        bytes memory sig = _sign(key, t, price, ts, window, thin);
        vm.expectRevert(sel);
        oracle.submit(t, price, ts, window, thin, sig);
    }

    function _submit(uint256 price, uint64 ts) internal {
        oracle.submit(token, price, ts, WINDOW, false, _sign(enginePk, token, price, ts, WINDOW, false));
    }

    function test_anyoneCanCarryASignedUpdateAndContractsReadIt() public {
        uint64 ts = uint64(block.timestamp - 20);
        bytes memory sig = _sign(enginePk, token, 4e12, ts, WINDOW, false);
        vm.prank(address(0xCAFE)); // a stranger pays the gas
        oracle.submit(token, 4e12, ts, WINDOW, false, sig);
        (uint256 price, uint64 at, uint32 window, bool thin) = oracle.latest(token);
        assertEq(price, 4e12);
        assertEq(at, ts);
        assertEq(window, WINDOW);
        assertFalse(thin);
        (uint256 p, uint64 t) = oracle.read(token, 60);
        assertEq(p, 4e12);
        assertEq(t, ts);
        assertEq(lender.valueOf(token, 1_000_000e18), 4e18);
        assertEq(oracle.decimals(), 18);
    }

    function test_attack_aForgedSignatureIsRefused() public {
        uint64 ts = uint64(block.timestamp);
        // signed by somebody who is not the engine
        _refuse(SpeculaTwapOracle.WrongSigner.selector, 0xBAD, token, 9e18, ts, WINDOW, false);
        // a real signature, with the price changed after signing
        bytes memory sig = _sign(enginePk, token, 4e12, ts, WINDOW, false);
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 9e18, ts, WINDOW, false, sig);
        // a real signature for one token, replayed for another
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(other, 4e12, ts, WINDOW, false, sig);
        // a real signature with the thin flag flipped, the window changed or the time moved
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 4e12, ts, WINDOW, true, sig);
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 4e12, ts, 60, false, sig);
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 4e12, ts + 1, WINDOW, false, sig);
        // garbage of the right and of the wrong length
        vm.expectRevert();
        oracle.submit(token, 4e12, ts, WINDOW, false, new bytes(65));
        vm.expectRevert();
        oracle.submit(token, 4e12, ts, WINDOW, false, hex"1234");
        vm.expectRevert(SpeculaTwapOracle.NoReading.selector);
        oracle.latest(token);
    }

    function test_attack_anOldUpdateCannotBeReplayed() public {
        uint64 t1 = uint64(block.timestamp - 100);
        uint64 t2 = uint64(block.timestamp - 10);
        bytes memory oldSig = _sign(enginePk, token, 9e12, t1, WINDOW, false);
        oracle.submit(token, 9e12, t1, WINDOW, false, oldSig);
        _submit(4e12, t2);
        // the earlier, higher price is real and signed, and must not come back
        vm.expectRevert(SpeculaTwapOracle.NotNewer.selector);
        oracle.submit(token, 9e12, t1, WINDOW, false, oldSig);
        // nor may the current one be submitted twice
        _refuse(SpeculaTwapOracle.NotNewer.selector, enginePk, token, 4e12, t2, WINDOW, false);
        (uint256 price,,,) = oracle.latest(token);
        assertEq(price, 4e12);
        // a different token keeps its own clock
        oracle.submit(other, 1e12, t1, WINDOW, false, _sign(enginePk, other, 1e12, t1, WINDOW, false));
    }

    function test_attack_aStalePriceIsNotGivenOut() public {
        _submit(4e12, uint64(block.timestamp));
        (uint256 p,) = oracle.read(token, 10 minutes);
        assertEq(p, 4e12);
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.expectRevert(SpeculaTwapOracle.TooOld.selector);
        oracle.read(token, 10 minutes);
        vm.expectRevert(SpeculaTwapOracle.TooOld.selector);
        lender.valueOf(token, 1e18);
        // the raw reading is still there for anyone who wants to look at it, with its time
        (, uint64 at,,) = oracle.latest(token);
        assertEq(at, uint64(block.timestamp - 10 minutes - 1));
    }

    function test_aThinMarketReplacesThePriceAndReadRefuses() public {
        _submit(4e12, uint64(block.timestamp - 60));
        uint64 ts = uint64(block.timestamp);
        oracle.submit(token, 0, ts, WINDOW, true, _sign(enginePk, token, 0, ts, WINDOW, true));
        vm.expectRevert(SpeculaTwapOracle.ThinMarket.selector);
        oracle.read(token, 1 hours);
        vm.expectRevert(SpeculaTwapOracle.ThinMarket.selector);
        lender.valueOf(token, 1e18);
        (uint256 price,,, bool thin) = oracle.latest(token);
        assertEq(price, 0);
        assertTrue(thin);
        // trading comes back: a newer price is accepted and read again
        vm.warp(block.timestamp + 120);
        _submit(5e12, uint64(block.timestamp));
        (uint256 p,) = oracle.read(token, 60);
        assertEq(p, 5e12);
    }

    function test_aThinUpdateCarriesNoPriceAndAPriceUpdateCarriesOne() public {
        uint64 ts = uint64(block.timestamp);
        _refuse(SpeculaTwapOracle.BadUpdate.selector, enginePk, token, 4e12, ts, WINDOW, true);
        _refuse(SpeculaTwapOracle.BadUpdate.selector, enginePk, token, 0, ts, WINDOW, false);
    }

    function test_anUpdateFromTheFutureIsRefused() public {
        uint64 ts = uint64(block.timestamp + 5 minutes + 1);
        _refuse(SpeculaTwapOracle.FromTheFuture.selector, enginePk, token, 4e12, ts, WINDOW, false);
    }

    function test_anUpdateIsBoundToThisContractAndChain() public {
        uint64 ts = uint64(block.timestamp);
        bytes memory sig = _sign(enginePk, token, 4e12, ts, WINDOW, false);
        SpeculaTwapOracle twin = new SpeculaTwapOracle(engine, WINDOW);
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        twin.submit(token, 4e12, ts, WINDOW, false, sig);
        vm.chainId(999);
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 4e12, ts, WINDOW, false, sig);
    }

    function test_ownerRotatesTheSignerAndOldSignaturesStopWorking() public {
        uint64 ts = uint64(block.timestamp);
        bytes memory sig = _sign(enginePk, token, 4e12, ts, WINDOW, false);
        vm.prank(address(0xBEEF));
        vm.expectRevert(SpeculaTwapOracle.NotOwner.selector);
        oracle.setSigner(address(0xBEEF));
        oracle.setSigner(vm.addr(0xE2));
        vm.expectRevert(SpeculaTwapOracle.WrongSigner.selector);
        oracle.submit(token, 4e12, ts, WINDOW, false, sig);
        oracle.submit(token, 4e12, ts, WINDOW, false, _sign(0xE2, token, 4e12, ts, WINDOW, false));
        oracle.transferOwnership(address(0xA1));
        vm.prank(address(0xA1));
        oracle.acceptOwnership();
        assertEq(oracle.owner(), address(0xA1));
        vm.expectRevert(SpeculaTwapOracle.NotOwner.selector);
        oracle.setSigner(engine);
    }

    function testFuzz_onlyStrictlyNewerUpdatesAreKept(uint64 a, uint64 b, uint128 pb) public {
        a = uint64(bound(a, 1, block.timestamp));
        b = uint64(bound(b, 1, block.timestamp));
        uint256 price = uint256(pb) + 1;
        _submit(7e12, a);
        if (b > a) {
            _submit(price, b);
            (uint256 p, uint64 t,,) = oracle.latest(token);
            assertEq(p, price);
            assertEq(t, b);
        } else {
            bytes memory sig = _sign(enginePk, token, price, b, WINDOW, false);
            vm.expectRevert(SpeculaTwapOracle.NotNewer.selector);
            oracle.submit(token, price, b, WINDOW, false, sig);
        }
    }

    /// The engine (engine/src/chain/twap.ts) hashes an update with its own code. This is the same update hashed here:
    /// if either side changes its encoding, this test or the engine's twin of it fails.
    function test_theEngineAndTheContractHashAnUpdateTheSameWay() public {
        address at = address(uint160(0xAC1E5));
        deployCodeTo("SpeculaTwapOracle.sol:SpeculaTwapOracle", abi.encode(engine, WINDOW), at);
        vm.chainId(31337);
        bytes32 h = SpeculaTwapOracle(at).updateHash(0x1111111111111111111111111111111111111111, 123456789012345678, 1_800_000_000, 1800, false);
        assertEq(h, ENGINE_VECTOR);
    }

    /// Anyone can fetch a signed update for any window. A short window is thin far more often: if its thin update
    /// could land here it would switch off the price consumers read from the long window. Only this contract's window counts.
    function test_attack_anUpdateForAnotherWindowIsRefused() public {
        _submit(4e12, uint64(block.timestamp - 30));
        uint64 now_ = uint64(block.timestamp);
        _refuse(SpeculaTwapOracle.WrongWindow.selector, enginePk, token, 0, now_, 300, true);
        _refuse(SpeculaTwapOracle.WrongWindow.selector, enginePk, token, 9e12, now_, 300, false);
        (uint256 price,) = oracle.read(token, 10 minutes);
        assertEq(price, 4e12);
        assertEq(oracle.window(), WINDOW);
    }

    function test_theSignerIsNeverTheZeroAddress() public {
        vm.expectRevert(SpeculaTwapOracle.ZeroSigner.selector);
        new SpeculaTwapOracle(address(0), WINDOW);
        vm.expectRevert(SpeculaTwapOracle.ZeroSigner.selector);
        oracle.setSigner(address(0));
    }

    bytes32 constant ENGINE_VECTOR = 0xd143c26b984f8853ddb4e50faccba1c8000b1bd0174484572b059e5b87c914f6;
}
