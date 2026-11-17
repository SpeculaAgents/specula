// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice Escrow for data bounties. A funder locks a reward for data that does not exist yet. Only the funder can
/// release it, to the seller who delivered, at any time; or take it back once the deadline has passed. Nobody else,
/// the engine included, can move the money. There is no owner and no fee. Bounties are kept per funder: an id is the
/// funder's own, so nobody can open it first and lock the funder out.
contract SpeculaBounties {
    struct Bounty {
        address funder;
        uint256 amount;
        uint64 deadline;
        address winner;
        bool closed;
    }

    IERC20 public immutable token;
    mapping(bytes32 => Bounty) private _bounties;

    event Opened(bytes32 indexed id, address indexed funder, uint256 amount, uint64 deadline);
    event Awarded(bytes32 indexed id, address indexed seller, uint256 amount);
    event Refunded(bytes32 indexed id, uint256 amount);

    error Exists();
    error NothingToLock();
    error BadDeadline();
    error NotFunder();
    error Closed();
    error TooEarly();
    error BadSeller();
    error TransferFailed();

    constructor(IERC20 token_) {
        token = token_;
    }

    /// @notice Where a funder's bounty is kept.
    function keyOf(address funder, bytes32 id) public pure returns (bytes32) {
        return keccak256(abi.encode(funder, id));
    }

    /// @notice A funder's bounty. All zero when that funder never opened that id.
    function bountyOf(address funder, bytes32 id)
        external
        view
        returns (address funder_, uint256 amount, uint64 deadline, address winner, bool closed)
    {
        Bounty memory b = _bounties[keyOf(funder, id)];
        return (b.funder, b.amount, b.deadline, b.winner, b.closed);
    }

    function open(bytes32 id, uint256 amount, uint64 deadline) external {
        bytes32 key = keyOf(msg.sender, id);
        if (_bounties[key].funder != address(0)) revert Exists();
        if (amount == 0) revert NothingToLock();
        if (deadline <= block.timestamp) revert BadDeadline();
        _bounties[key] = Bounty(msg.sender, amount, deadline, address(0), false);
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Opened(id, msg.sender, amount, deadline);
    }

    function award(bytes32 id, address seller) external {
        Bounty storage b = _bounties[keyOf(msg.sender, id)];
        if (msg.sender != b.funder) revert NotFunder();
        if (b.closed) revert Closed();
        if (seller == address(0) || seller == b.funder) revert BadSeller();
        b.closed = true;
        b.winner = seller;
        if (!token.transfer(seller, b.amount)) revert TransferFailed();
        emit Awarded(id, seller, b.amount);
    }

    function refund(bytes32 id) external {
        Bounty storage b = _bounties[keyOf(msg.sender, id)];
        if (msg.sender != b.funder) revert NotFunder();
        if (b.closed) revert Closed();
        if (block.timestamp < b.deadline) revert TooEarly();
        b.closed = true;
        if (!token.transfer(b.funder, b.amount)) revert TransferFailed();
        emit Refunded(id, b.amount);
    }
}
