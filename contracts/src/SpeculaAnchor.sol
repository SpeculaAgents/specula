// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Hourly fingerprints of the answers the engine signed. One Merkle root per hour, written once and never
/// changed, so anyone can later prove that an answer existed in that hour and was not altered since.
contract SpeculaAnchor {
    struct Root {
        bytes32 root;
        uint32 count;
        uint64 anchoredAt;
    }

    address public owner;
    address public pendingOwner;
    address public poster;
    mapping(uint64 => Root) public roots;
    uint64 public lastHour;
    uint256 public anchored;

    event Anchored(uint64 indexed hour, bytes32 root, uint32 count);
    event PosterChanged(address indexed poster);
    event OwnerChanged(address indexed owner);

    error NotPoster();
    error NotOwner();
    error AlreadyAnchored();
    error HourNotOver();
    error EmptyRoot();

    constructor(address poster_) {
        owner = msg.sender;
        poster = poster_;
        emit OwnerChanged(msg.sender);
        emit PosterChanged(poster_);
    }

    /// @notice Write the root of one finished hour. `hour` is unix time divided by 3600.
    function anchor(uint64 hour, bytes32 root, uint32 count) external {
        if (msg.sender != poster) revert NotPoster();
        if (root == bytes32(0)) revert EmptyRoot();
        if (roots[hour].anchoredAt != 0) revert AlreadyAnchored();
        if ((uint256(hour) + 1) * 3600 > block.timestamp) revert HourNotOver();
        roots[hour] = Root(root, count, uint64(block.timestamp));
        if (hour > lastHour) lastHour = hour;
        anchored++;
        emit Anchored(hour, root, count);
    }

    /// @notice True if `leaf` is in the root anchored for `hour`. Pairs are hashed in sorted order.
    function verify(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = roots[hour].root;
        if (root == bytes32(0)) return false;
        bytes32 h = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    function setPoster(address poster_) external {
        if (msg.sender != owner) revert NotOwner();
        poster = poster_;
        emit PosterChanged(poster_);
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
