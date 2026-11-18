// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IPonsV2LaunchFactory} from "../src/interfaces/IPons.sol";

interface ICurveB { function buy(uint256, uint256, address) external payable returns (uint256); }

/// Local rehearsal only (anvil fork): launch a test token paying SPLITTER, then trade on it.
contract ForkLaunch is Script {
    function run() external {
        IPonsV2LaunchFactory f = IPonsV2LaunchFactory(0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e);
        address splitter = vm.envAddress("SPLITTER");
        IPonsV2LaunchFactory.TokenParams memory p;
        p.name = "Rehearsal"; p.symbol = "REH"; p.logo = "ipfs://x"; p.description = "local rehearsal";
        p.creatorFeeRecipient = splitter; p.creatorTaxBps = 300; p.buybackEnabled = false;
        p.expectedEconomics = f.previewLaunchEconomics(0, address(0));
        p.salt = keccak256(abi.encode(block.timestamp, splitter));
        vm.startBroadcast();
        (address t, address c) = f.launchToken{value: f.launchFee()}(p, 0, address(0), new address[](0));
        vm.stopBroadcast();
        console2.log("TOKEN", t);
        console2.log("CURVE", c);
    }
}
