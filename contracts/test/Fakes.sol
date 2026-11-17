// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Stand-ins for the engine's payment tests (engine/test/security.test.ts). Never deployed anywhere but a local chain.

/// Emits a Transfer that looks right but comes from the wrong contract.
contract Echo {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function say(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }
}

/// A token whose transferWithAuthorization succeeds without moving anything. The Transfer in its receipt is emitted by
/// another contract. With `value` 7 it burns gas first, to stand for a call far above what a payment should cost.
contract SilentUSDG {
    string public constant name = "Global Dollar";
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    Echo public immutable echo = new Echo();
    uint256 public sink;

    function balanceOf(address) external pure returns (uint256) {
        return 1e12;
    }

    function authorizationState(address, bytes32) external pure returns (bool) {
        return false;
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256, uint256, bytes32, bytes calldata) external {
        if (value == 7) for (uint256 i = 0; i < 400; i++) sink = uint256(keccak256(abi.encode(sink, i)));
        echo.say(from, to, value);
    }
}

/// A contract that calls every signature its own: the shape of a fake wallet.
contract YesWallet {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}
