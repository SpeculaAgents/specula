// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Sig} from "./Sig.sol";

/// @notice A pull oracle. The engine signs a report (id, value, timestamp) off chain; anyone may carry it here, and
/// the contract checks the engine's signature rather than who sent it. Values have 8 decimals. A report is bound to
/// this chain and this contract, cannot move a feed backwards in time, and cannot come from the future.
contract SpeculaOracle {
    struct Reading {
        int256 value;
        uint64 timestamp;
    }

    address public owner;
    address public pendingOwner;
    address public signer;
    uint64 public constant MAX_DRIFT = 5 minutes;
    uint8 public constant decimals = 8;
    mapping(bytes32 => Reading) private _latest;

    event Posted(bytes32 indexed id, int256 value, uint64 timestamp);
    event SignerChanged(address indexed signer);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error WrongSigner();
    error Stale();
    error FromTheFuture();
    error NoReading();
    error TooOld();

    constructor(address signer_) {
        owner = msg.sender;
        signer = signer_;
        emit OwnerChanged(msg.sender);
        emit SignerChanged(signer_);
    }

    function reportHash(bytes32 id, int256 value, uint64 timestamp) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, value, timestamp));
    }

    function post(bytes32 id, int256 value, uint64 timestamp, bytes calldata signature) external {
        if (Sig.recover(Sig.personal(reportHash(id, value, timestamp)), signature) != signer) revert WrongSigner();
        if (timestamp > block.timestamp + MAX_DRIFT) revert FromTheFuture();
        if (timestamp <= _latest[id].timestamp) revert Stale();
        _latest[id] = Reading(value, timestamp);
        emit Posted(id, value, timestamp);
    }

    function latest(bytes32 id) external view returns (int256 value, uint64 timestamp) {
        Reading memory r = _latest[id];
        if (r.timestamp == 0) revert NoReading();
        return (r.value, r.timestamp);
    }

    /// @notice The latest value, or a revert if it is older than `maxAge` seconds. What a consumer should call.
    function read(bytes32 id, uint64 maxAge) external view returns (int256) {
        Reading memory r = _latest[id];
        if (r.timestamp == 0) revert NoReading();
        if (block.timestamp > uint256(r.timestamp) + maxAge) revert TooOld();
        return r.value;
    }

    function setSigner(address signer_) external {
        if (msg.sender != owner) revert NotOwner();
        signer = signer_;
        emit SignerChanged(signer_);
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = next;
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(msg.sender);
    }
}
