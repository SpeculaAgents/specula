// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Sig} from "./Sig.sol";

/// @notice A pull oracle for token prices. The engine works out a time-weighted price per token from the swaps it has
/// indexed and signs an update off chain; anyone may carry the update here and pay the gas. The contract checks the
/// engine's signature rather than who sent it, and keeps an update only if it is newer than the one it holds.
/// A price is the quote asset per whole token with 18 decimals. When trading is too thin for a price, the engine signs
/// a "thin market" update instead: it replaces the last price, and `read` refuses to give one out.
/// An update is bound to this chain and this contract, cannot move a token backwards in time and cannot be from the future.
/// Each contract holds one averaging window, fixed at deployment: an update for any other window is refused, so a
/// shorter, easier to move or more often thin window can never stand in for the one consumers rely on.
contract SpeculaTwapOracle {
    struct Reading {
        uint256 price;
        uint64 timestamp;
        uint32 window;
        bool thin;
    }

    address public owner;
    address public pendingOwner;
    address public signer;
    uint64 public constant MAX_DRIFT = 5 minutes;
    uint8 public constant decimals = 18;
    /// @notice The averaging window, in seconds, of every price this contract holds.
    uint32 public immutable window;
    mapping(address => Reading) private _latest;

    event Updated(address indexed token, uint256 price, uint64 timestamp, uint32 window, bool thin);
    event SignerChanged(address indexed signer);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error WrongSigner();
    error NotNewer();
    error FromTheFuture();
    error BadUpdate();
    error NoReading();
    error TooOld();
    error ThinMarket();
    error WrongWindow();
    error ZeroSigner();

    constructor(address signer_, uint32 window_) {
        if (signer_ == address(0)) revert ZeroSigner();
        if (window_ == 0) revert WrongWindow();
        window = window_;
        owner = msg.sender;
        signer = signer_;
        emit OwnerChanged(msg.sender);
        emit SignerChanged(signer_);
    }

    /// @notice What the engine signs (as a personal message).
    function updateHash(address token, uint256 price, uint64 timestamp, uint32 window_, bool thin) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), token, price, timestamp, window_, thin));
    }

    /// @notice Store a signed update. Open to anyone: the signature is what is checked.
    function submit(address token, uint256 price, uint64 timestamp, uint32 window_, bool thin, bytes calldata signature) external {
        if (Sig.recover(Sig.personal(updateHash(token, price, timestamp, window_, thin)), signature) != signer) revert WrongSigner();
        if (window_ != window) revert WrongWindow();
        // A thin update carries no price, and a price update must carry one.
        if (thin ? price != 0 : price == 0) revert BadUpdate();
        if (timestamp > block.timestamp + MAX_DRIFT) revert FromTheFuture();
        if (timestamp <= _latest[token].timestamp) revert NotNewer();
        _latest[token] = Reading(price, timestamp, window_, thin);
        emit Updated(token, price, timestamp, window_, thin);
    }

    /// @notice The latest update as stored, thin or not, with its time. Reverts if the token has none.
    function latest(address token) external view returns (uint256 price, uint64 timestamp, uint32 window_, bool thin) {
        Reading memory r = _latest[token];
        if (r.timestamp == 0) revert NoReading();
        return (r.price, r.timestamp, r.window, r.thin);
    }

    /// @notice The latest price and its time, or a revert if the market is thin or the price is older than `maxAge`
    /// seconds. What a consumer should call.
    function read(address token, uint64 maxAge) external view returns (uint256 price, uint64 timestamp) {
        Reading memory r = _latest[token];
        if (r.timestamp == 0) revert NoReading();
        if (r.thin) revert ThinMarket();
        if (block.timestamp > uint256(r.timestamp) + maxAge) revert TooOld();
        return (r.price, r.timestamp);
    }

    function setSigner(address signer_) external {
        if (msg.sender != owner) revert NotOwner();
        if (signer_ == address(0)) revert ZeroSigner();
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
