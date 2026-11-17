// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {SpeculaAnchor} from "../src/SpeculaAnchor.sol";
import {SpeculaOracle} from "../src/SpeculaOracle.sol";
import {Sig} from "../src/Sig.sol";

contract MockUSDGTest is Test {
    MockUSDG usdg;
    uint256 pk = 0xA11CE;
    address payer;
    address payee = address(0xBEEF);

    function setUp() public {
        usdg = new MockUSDG();
        payer = vm.addr(pk);
        usdg.mint(payer, 10e6);
        vm.warp(1_800_000_000);
    }

    function _sign(uint256 key, address from, address to, uint256 value, uint256 afterT, uint256 beforeT, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(usdg.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, afterT, beforeT, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_domainMatchesTheRealTokensShape() public view {
        bytes32 expected = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("Global Dollar"), keccak256("1"), block.chainid, address(usdg)));
        assertEq(usdg.DOMAIN_SEPARATOR(), expected);
        assertEq(usdg.decimals(), 6);
    }

    function test_authorizedTransferMovesExactAmountOnce() public {
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _sign(pk, payer, payee, 1000, 0, block.timestamp + 60, nonce);
        usdg.transferWithAuthorization(payer, payee, 1000, 0, block.timestamp + 60, nonce, sig);
        assertEq(usdg.balanceOf(payee), 1000);
        assertEq(usdg.balanceOf(payer), 10e6 - 1000);
        assertTrue(usdg.authorizationState(payer, nonce));
        vm.expectRevert(MockUSDG.AuthorizationAlreadyUsed.selector);
        usdg.transferWithAuthorization(payer, payee, 1000, 0, block.timestamp + 60, nonce, sig);
    }

    function test_rejectsWrongSignerExpiredAndChangedAmount() public {
        bytes32 nonce = keccak256("n2");
        bytes memory bad = _sign(0xB0B, payer, payee, 1000, 0, block.timestamp + 60, nonce);
        vm.expectRevert(MockUSDG.InvalidSigner.selector);
        usdg.transferWithAuthorization(payer, payee, 1000, 0, block.timestamp + 60, nonce, bad);
        bytes memory sig = _sign(pk, payer, payee, 1000, 0, block.timestamp + 60, nonce);
        vm.expectRevert(MockUSDG.InvalidSigner.selector);
        usdg.transferWithAuthorization(payer, payee, 2000, 0, block.timestamp + 60, nonce, sig);
        vm.expectRevert(MockUSDG.InvalidSigner.selector);
        usdg.transferWithAuthorization(payer, address(0xDEAD), 1000, 0, block.timestamp + 60, nonce, sig);
        uint256 beforeT = block.timestamp + 60;
        vm.warp(block.timestamp + 61);
        vm.expectRevert(MockUSDG.AuthorizationExpired.selector);
        usdg.transferWithAuthorization(payer, payee, 1000, 0, beforeT, nonce, sig);
    }

    function testFuzz_cannotSpendMoreThanBalance(uint256 value) public {
        value = bound(value, 10e6 + 1, type(uint128).max);
        bytes32 nonce = keccak256(abi.encode(value));
        bytes memory sig = _sign(pk, payer, payee, value, 0, block.timestamp + 60, nonce);
        vm.expectRevert(MockUSDG.InsufficientBalance.selector);
        usdg.transferWithAuthorization(payer, payee, value, 0, block.timestamp + 60, nonce, sig);
    }
}

contract SpeculaAnchorTest is Test {
    SpeculaAnchor anchor;
    address poster = address(0x9057);

    function setUp() public {
        anchor = new SpeculaAnchor(poster);
        vm.warp(1_800_000_000);
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_anchorOnceAndVerify() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32 c = keccak256("c");
        bytes32 root = _pair(_pair(a, b), c);
        uint64 hour = uint64(block.timestamp / 3600) - 1;
        vm.prank(poster);
        anchor.anchor(hour, root, 3);
        (bytes32 r, uint32 n, uint64 at) = anchor.roots(hour);
        assertEq(r, root);
        assertEq(n, 3);
        assertEq(at, block.timestamp);
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = b;
        proof[1] = c;
        assertTrue(anchor.verify(hour, a, proof));
        proof[0] = keccak256("x");
        assertFalse(anchor.verify(hour, a, proof));
        bytes32[] memory single = new bytes32[](1);
        single[0] = _pair(a, b);
        assertTrue(anchor.verify(hour, c, single));
        vm.prank(poster);
        vm.expectRevert(SpeculaAnchor.AlreadyAnchored.selector);
        anchor.anchor(hour, keccak256("other"), 1);
    }

    function test_onlyPosterOnlyFinishedHoursNoEmptyRoot() public {
        uint64 hour = uint64(block.timestamp / 3600);
        vm.expectRevert(SpeculaAnchor.NotPoster.selector);
        anchor.anchor(hour - 1, keccak256("r"), 1);
        vm.startPrank(poster);
        vm.expectRevert(SpeculaAnchor.HourNotOver.selector);
        anchor.anchor(hour, keccak256("r"), 1);
        vm.expectRevert(SpeculaAnchor.EmptyRoot.selector);
        anchor.anchor(hour - 1, bytes32(0), 0);
        vm.stopPrank();
        assertFalse(anchor.verify(hour - 1, keccak256("a"), new bytes32[](0)));
    }

    function test_ownerRotatesPosterInTwoSteps() public {
        vm.expectRevert(SpeculaAnchor.NotOwner.selector);
        vm.prank(address(1));
        anchor.setPoster(address(1));
        anchor.setPoster(address(2));
        assertEq(anchor.poster(), address(2));
        anchor.transferOwnership(address(3));
        assertEq(anchor.owner(), address(this));
        vm.prank(address(3));
        anchor.acceptOwnership();
        assertEq(anchor.owner(), address(3));
    }
}

contract SpeculaOracleTest is Test {
    SpeculaOracle oracle;
    uint256 enginePk = 0xE9617E;
    bytes32 constant ID = bytes32("index:ai");

    function setUp() public {
        oracle = new SpeculaOracle(vm.addr(enginePk));
        vm.warp(1_800_000_000);
    }

    function _report(uint256 key, bytes32 id, int256 value, uint64 ts) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, Sig.personal(oracle.reportHash(id, value, ts)));
        return abi.encodePacked(r, s, v);
    }

    function test_anyoneCanCarryASignedReport() public {
        uint64 ts = uint64(block.timestamp);
        bytes memory sig = _report(enginePk, ID, 1012_34000000, ts);
        vm.prank(address(0xCAFE));
        oracle.post(ID, 1012_34000000, ts, sig);
        (int256 v, uint64 t) = oracle.latest(ID);
        assertEq(v, 1012_34000000);
        assertEq(t, ts);
        assertEq(oracle.read(ID, 60), 1012_34000000);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(SpeculaOracle.TooOld.selector);
        oracle.read(ID, 60);
    }

    function test_rejectsForgedChangedReplayedAndFutureReports() public {
        uint64 ts = uint64(block.timestamp);
        bytes memory forged = _report(0xBAD, ID, 5, ts);
        vm.expectRevert(SpeculaOracle.WrongSigner.selector);
        oracle.post(ID, 5, ts, forged);
        bytes memory sig = _report(enginePk, ID, 5, ts);
        vm.expectRevert(SpeculaOracle.WrongSigner.selector);
        oracle.post(ID, 6, ts, sig);
        vm.expectRevert(SpeculaOracle.WrongSigner.selector);
        oracle.post(bytes32("index:other"), 5, ts, sig);
        oracle.post(ID, 5, ts, sig);
        vm.expectRevert(SpeculaOracle.Stale.selector);
        oracle.post(ID, 5, ts, sig);
        uint64 future = ts + 6 minutes;
        bytes memory f = _report(enginePk, ID, 7, future);
        vm.expectRevert(SpeculaOracle.FromTheFuture.selector);
        oracle.post(ID, 7, future, f);
        vm.expectRevert(SpeculaOracle.NoReading.selector);
        oracle.latest(bytes32("none"));
    }

    function test_reportIsBoundToThisContractAndChain() public {
        SpeculaOracle other = new SpeculaOracle(vm.addr(enginePk));
        uint64 ts = uint64(block.timestamp);
        bytes memory sig = _report(enginePk, ID, 5, ts);
        vm.expectRevert(SpeculaOracle.WrongSigner.selector);
        other.post(ID, 5, ts, sig);
        vm.chainId(999);
        vm.expectRevert(SpeculaOracle.WrongSigner.selector);
        oracle.post(ID, 5, ts, sig);
    }

    function test_ownerRotatesSigner() public {
        vm.prank(address(1));
        vm.expectRevert(SpeculaOracle.NotOwner.selector);
        oracle.setSigner(address(1));
        oracle.setSigner(vm.addr(0xBAD));
        uint64 ts = uint64(block.timestamp);
        oracle.post(ID, 9, ts, _report(0xBAD, ID, 9, ts));
        (int256 v,) = oracle.latest(ID);
        assertEq(v, 9);
    }
}
