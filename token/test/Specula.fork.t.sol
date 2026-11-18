// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpeculaSplitter} from "../src/SpeculaSplitter.sol";
import {SpeculaSwap} from "../src/SpeculaSwap.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

interface IFactoryX {
    function createGraduatedPool(address token) external returns (uint256);
}

interface ICurveX {
    function buy(uint256, uint256, address) external payable returns (uint256);
}

interface IPonsToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function burn(uint256) external;
}

/// The splitter and the swap against the real Pons on a fork of Robinhood Chain, the way launch day goes: both
/// deployed from the buyback wallet, $SPECULA launched with its fees to the splitter (3% creator tax, buyback off, ETH
/// pair), fees through the real curve and escrow, the buyback wallet buying and burning exactly what it bought, and
/// a buy in the real Uniswap v4 pool after graduation. RPC_URL="" skips them. Nothing reaches the real chain.
contract SpeculaForkTest is Test {
    string constant DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
    string constant UNSET = "__RPC_URL_UNSET__";
    IPonsV2LaunchFactory constant FACTORY = IPonsV2LaunchFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
    address payable constant TEAM = payable(0x4b9D2eFb9878504a060fE147bF558014FE010EBe);
    address payable constant BUYBACK = payable(0xF9E50b701EC0e0FFe64B1E993177eC22Ba834588);

    address launcher = makeAddr("launch wallet");
    address trader = makeAddr("trader");

    SpeculaSplitter splitter;
    SpeculaSwap swapper;
    IPonsToken token;
    ICurveX curve;

    function setUp() public {
        string memory url = vm.envOr("RPC_URL", string(UNSET));
        if (keccak256(bytes(url)) == keccak256(bytes(UNSET))) url = DEFAULT_RPC;
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        bytes memory raw = vm.rpc(url, "eth_blockNumber", "[]");
        uint256 head;
        for (uint256 i = 0; i < raw.length; ++i) head = (head << 8) | uint8(raw[i]);
        vm.createSelectFork(url, ((head - 20) / 500) * 500);

        uint64 n = vm.getNonce(BUYBACK);
        vm.startPrank(BUYBACK);
        splitter = new SpeculaSplitter(TEAM, BUYBACK, FACTORY);
        swapper = new SpeculaSwap(FACTORY);
        vm.stopPrank();
        assertEq(address(splitter), vm.computeCreateAddress(BUYBACK, n));
        assertEq(address(swapper), vm.computeCreateAddress(BUYBACK, n + 1));
        vm.deal(trader, 100 ether);
    }

    function _params(address feeTo, uint16 tax) internal view returns (IPonsV2LaunchFactory.TokenParams memory p) {
        p.name = "Specula";
        p.symbol = "SPECULA";
        p.logo = "ipfs://specula-fork-test";
        p.description = "Data terminal for AI agents.";
        p.creatorFeeRecipient = feeTo;
        p.creatorTaxBps = tax;
        p.buybackEnabled = false;
        p.expectedEconomics = FACTORY.previewLaunchEconomics(0, address(0));
        p.salt = keccak256(abi.encode("specula-fork", feeTo, tax));
    }

    function _launch(address feeTo, uint16 tax) internal returns (address a) {
        uint256 fee = FACTORY.launchFee();
        vm.deal(launcher, launcher.balance + fee);
        vm.prank(launcher);
        (a,) = FACTORY.launchToken{value: fee}(_params(feeTo, tax), 0, address(0), new address[](0));
    }

    function _launchAndSet() internal {
        address a = _launch(address(splitter), 300);
        token = IPonsToken(a);
        curve = ICurveX(FACTORY.getLaunchedToken(a).curve);
        vm.prank(BUYBACK);
        splitter.setToken(a);
        vm.warp(block.timestamp + 10 minutes); // past the launch-second snipe tax
    }

    function test_fork_setTokenOnlyAcceptsALaunchPayingThisSplitter() public {
        address other = _launch(makeAddr("someone else"), 300);
        vm.prank(BUYBACK);
        vm.expectRevert(abi.encodeWithSelector(SpeculaSplitter.WrongFeeRecipient.selector, makeAddr("someone else")));
        splitter.setToken(other);

        address a = _launch(address(splitter), 300);
        vm.prank(trader);
        vm.expectRevert(SpeculaSplitter.NotSetter.selector);
        splitter.setToken(a);
        vm.prank(BUYBACK);
        splitter.setToken(a);
        vm.prank(BUYBACK);
        vm.expectRevert(SpeculaSplitter.TokenAlreadySet.selector);
        splitter.setToken(a);
    }

    function test_fork_feesSplitSeventyThirtyToTheTwoWallets() public {
        _launchAndSet();
        vm.prank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);
        uint256 t0 = TEAM.balance;
        uint256 b0 = BUYBACK.balance;
        uint256 amount = splitter.sweep();
        assertGt(amount, 0, "the curve's fees were released, claimed and split");
        assertEq(TEAM.balance - t0, (amount * 7000) / 10000);
        assertEq(BUYBACK.balance - b0, amount - (amount * 7000) / 10000);
        assertEq(splitter.totalToTeam() + splitter.totalToBuyback(), amount);
        assertEq(address(splitter).balance, 0, "nothing kept");
    }

    /// The bot's run: buy on the curve from the buyback wallet with what the splitter sent, then burn exactly that.
    function test_fork_buybackWalletBuysAndBurnsExactlyWhatItBought() public {
        _launchAndSet();
        vm.prank(trader);
        curve.buy{value: 2 ether}(2 ether, 0, trader);
        splitter.sweep();
        uint256 owed = splitter.totalToBuyback();
        // the wallet's own holding, which must not be touched
        vm.prank(trader);
        token.transfer(BUYBACK, 1_000 ether);
        uint256 own = token.balanceOf(BUYBACK);

        uint256 supply = token.totalSupply();
        vm.prank(BUYBACK);
        uint256 got = curve.buy{value: owed}(owed, 0, BUYBACK);
        assertEq(token.balanceOf(BUYBACK), own + got);
        vm.prank(BUYBACK);
        token.burn(got);
        assertEq(token.balanceOf(BUYBACK), own, "the wallet's own holding is untouched");
        assertEq(supply - token.totalSupply(), got, "the supply fell by exactly what was bought");
    }

    function test_fork_tokensSentToTheSplitterAreBurned() public {
        _launchAndSet();
        vm.prank(trader);
        curve.buy{value: 0.1 ether}(0.1 ether, 0, trader);
        vm.prank(trader);
        token.transfer(address(splitter), 500 ether);
        uint256 supply = token.totalSupply();
        assertEq(splitter.burnTokens(), 500 ether);
        assertEq(supply - token.totalSupply(), 500 ether);
    }

    function test_fork_swapBuysOnTheCurveAndRefundsNothingLeft() public {
        _launchAndSet();
        uint256 bal = BUYBACK.balance + 0.01 ether;
        vm.deal(BUYBACK, bal);
        vm.prank(BUYBACK);
        (uint256 ethIn, uint256 out) = swapper.buy{value: 0.01 ether}(address(token), 1, BUYBACK);
        assertEq(ethIn, 0.01 ether);
        assertEq(token.balanceOf(BUYBACK), out);
        assertEq(address(swapper).balance, 0);
    }

    function test_fork_afterGraduationTheSwapBuysInThePool() public {
        _launchAndSet();
        vm.prank(trader);
        curve.buy{value: 10 ether}(10 ether, 0, trader); // buys the curve out
        assertEq(uint8(FACTORY.getLaunchedToken(address(token)).phase), 1, "graduated, no pool yet");
        vm.deal(BUYBACK, 1 ether);
        vm.prank(BUYBACK);
        vm.expectRevert(SpeculaSwap.MarketClosed.selector);
        swapper.buy{value: 0.005 ether}(address(token), 0, BUYBACK);

        IFactoryX(address(FACTORY)).createGraduatedPool(address(token));
        uint256 before = BUYBACK.balance;
        vm.prank(BUYBACK);
        (uint256 ethIn, uint256 out) = swapper.buy{value: 0.005 ether}(address(token), 1, BUYBACK);
        assertGt(out, 0);
        assertLe(ethIn, 0.005 ether);
        assertEq(before - BUYBACK.balance, ethIn, "only what was swapped left the wallet");
        uint256 supply = token.totalSupply();
        vm.prank(BUYBACK);
        token.burn(out);
        assertEq(supply - token.totalSupply(), out);
        assertEq(address(swapper).balance, 0);
    }

    /// A wallet that refuses its share does not hold up the other; its share waits under its name.
    function test_fork_aRefusedShareWaitsAndTheOtherIsPaid() public {
        _launchAndSet();
        vm.prank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);
        bytes memory code = TEAM.code;
        vm.etch(TEAM, hex"60006000fd"); // revert on any call
        uint256 b0 = BUYBACK.balance;
        uint256 amount = splitter.sweep();
        uint256 toTeam = (amount * 7000) / 10000;
        assertEq(splitter.pendingOf(TEAM), toTeam);
        assertEq(BUYBACK.balance - b0, amount - toTeam, "the buyback share still arrived");
        vm.etch(TEAM, code);
        uint256 t0 = TEAM.balance;
        splitter.retry();
        assertEq(TEAM.balance - t0, toTeam);
        assertEq(splitter.pending(), 0);
    }

    /// A share is handed on only when the new address accepts; strangers can do neither step.
    function test_fork_aShareIsHandedOnInTwoSteps() public {
        address payable next = payable(makeAddr("new buyback wallet"));
        vm.prank(trader);
        vm.expectRevert(SpeculaSplitter.NotAllowed.selector);
        splitter.proposePayee(next);
        vm.prank(BUYBACK);
        splitter.proposePayee(next);
        assertEq(splitter.buyback(), BUYBACK, "nothing changes before the accept");
        vm.prank(trader);
        vm.expectRevert(SpeculaSplitter.NothingProposed.selector);
        splitter.acceptPayee();
        vm.prank(next);
        splitter.acceptPayee();
        assertEq(splitter.buyback(), next);
        assertEq(splitter.team(), TEAM);
    }
}
