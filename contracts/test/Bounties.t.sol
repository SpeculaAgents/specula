// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {SpeculaBounties, IERC20} from "../src/SpeculaBounties.sol";

contract SpeculaBountiesTest is Test {
    MockUSDG usdg;
    SpeculaBounties esc;
    address funder = address(0xF00D);
    address seller = address(0x5E11);
    bytes32 constant ID = keccak256("bounty-1");

    function setUp() public {
        usdg = new MockUSDG();
        esc = new SpeculaBounties(IERC20(address(usdg)));
        usdg.mint(funder, 100e6);
        vm.warp(1_800_000_000);
        vm.prank(funder);
        usdg.approve(address(esc), type(uint256).max);
    }

    function test_openLocksTheRewardAndAwardPaysTheSeller() public {
        vm.prank(funder);
        esc.open(ID, 25e6, uint64(block.timestamp + 7 days));
        assertEq(usdg.balanceOf(address(esc)), 25e6);
        assertEq(usdg.balanceOf(funder), 75e6);
        vm.prank(funder);
        esc.award(ID, seller);
        assertEq(usdg.balanceOf(seller), 25e6);
        assertEq(usdg.balanceOf(address(esc)), 0);
        (,,, address winner, bool closed) = esc.bountyOf(funder, ID);
        assertEq(winner, seller);
        assertTrue(closed);
    }

    function test_onlyTheFunderCanMoveItAndOnlyOnce() public {
        vm.prank(funder);
        esc.open(ID, 10e6, uint64(block.timestamp + 1 days));
        vm.expectRevert(SpeculaBounties.NotFunder.selector);
        vm.prank(seller);
        esc.award(ID, seller);
        vm.expectRevert(SpeculaBounties.NotFunder.selector);
        esc.refund(ID);
        vm.startPrank(funder);
        vm.expectRevert(SpeculaBounties.BadSeller.selector);
        esc.award(ID, funder);
        vm.expectRevert(SpeculaBounties.BadSeller.selector);
        esc.award(ID, address(0));
        esc.award(ID, seller);
        vm.expectRevert(SpeculaBounties.Closed.selector);
        esc.award(ID, seller);
        vm.expectRevert(SpeculaBounties.Closed.selector);
        esc.refund(ID);
        vm.stopPrank();
        assertEq(usdg.balanceOf(seller), 10e6);
    }

    function test_refundOnlyAfterTheDeadline() public {
        vm.startPrank(funder);
        esc.open(ID, 10e6, uint64(block.timestamp + 1 days));
        vm.expectRevert(SpeculaBounties.TooEarly.selector);
        esc.refund(ID);
        vm.warp(block.timestamp + 1 days);
        esc.refund(ID);
        vm.stopPrank();
        assertEq(usdg.balanceOf(funder), 100e6);
        (,,, address winner, bool closed) = esc.bountyOf(funder, ID);
        assertEq(winner, address(0));
        assertTrue(closed);
    }

    function test_rejectsReuseEmptyAndPastDeadlines() public {
        vm.startPrank(funder);
        vm.expectRevert(SpeculaBounties.NothingToLock.selector);
        esc.open(ID, 0, uint64(block.timestamp + 1));
        vm.expectRevert(SpeculaBounties.BadDeadline.selector);
        esc.open(ID, 1, uint64(block.timestamp));
        esc.open(ID, 1e6, uint64(block.timestamp + 1));
        vm.expectRevert(SpeculaBounties.Exists.selector);
        esc.open(ID, 1e6, uint64(block.timestamp + 1));
        vm.stopPrank();
    }

    function testFuzz_escrowNeverPaysMoreThanWasLocked(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1, 40e6));
        b = uint96(bound(b, 1, 40e6));
        vm.startPrank(funder);
        esc.open(keccak256("a"), a, uint64(block.timestamp + 1 days));
        esc.open(keccak256("b"), b, uint64(block.timestamp + 1 days));
        esc.award(keccak256("a"), seller);
        vm.stopPrank();
        assertEq(usdg.balanceOf(seller), a);
        assertEq(usdg.balanceOf(address(esc)), b);
    }

    /// The id of a bounty is public before it is funded. Someone who sees it and opens it first gets their own
    /// bounty under that id, not the funder's: the funder can still lock the reward, and only the funder moves it.
    function test_attack_openingSomeoneElsesIdFirstDoesNotLockThemOut() public {
        address squatter = address(0xBAD);
        usdg.mint(squatter, 1);
        vm.startPrank(squatter);
        usdg.approve(address(esc), 1);
        esc.open(ID, 1, uint64(block.timestamp + 1 days));
        vm.stopPrank();
        vm.prank(funder);
        esc.open(ID, 25e6, uint64(block.timestamp + 7 days));
        (address f, uint256 amount,,,) = esc.bountyOf(funder, ID);
        assertEq(f, funder);
        assertEq(amount, 25e6);
        (address g, uint256 small,,,) = esc.bountyOf(squatter, ID);
        assertEq(g, squatter);
        assertEq(small, 1);
        vm.prank(squatter);
        esc.award(ID, seller);
        assertEq(usdg.balanceOf(seller), 1, "the squatter can only move its own 1 unit");
        vm.prank(funder);
        esc.award(ID, seller);
        assertEq(usdg.balanceOf(seller), 25e6 + 1);
    }
}
