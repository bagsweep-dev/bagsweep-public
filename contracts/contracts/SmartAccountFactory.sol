// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SmartAccount} from "./SmartAccount.sol";

/// @title SmartAccountFactory
/// @author BagSweep
/// @notice Deploys SmartAccount wallets using CREATE2 for deterministic addresses.
///         The frontend can compute a user's smart wallet address before it's
///         deployed (counterfactual), enabling token deposits ahead of deployment.
contract SmartAccountFactory {

    /// @dev Hash of SmartAccount creation code (for CREATE2 address computation).
    bytes32 public immutable accountInitCodeHash;

    /// @dev The default keeper address trusted by all deployed accounts.
    ///      Can be updated per-account after deployment.
    address public defaultKeeper;

    /// @dev Owner of the factory (can update default keeper).
    address public owner;

    event AccountCreated(
        address indexed account,
        address indexed ownerAddr,
        address keeper,
        uint256 salt
    );

    event DefaultKeeperSet(address indexed keeper);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _defaultKeeper) {
        defaultKeeper = _defaultKeeper;
        owner = msg.sender;
        accountInitCodeHash = keccak256(type(SmartAccount).creationCode);
    }

    // ─────────────────────────── Deploy ──────────────────────────────

    /// @notice Deploy a new SmartAccount for `ownerAddr` with CREATE2 salt.
    /// @param ownerAddr The user's EOA that owns the smart wallet.
    /// @param salt Arbitrary salt for CREATE2 (use 0 for default).
    /// @return account The deployed SmartAccount address.
    function createAccount(
        address ownerAddr,
        uint256 salt
    ) external returns (address account) {
        bytes32 saltBytes = bytes32(salt);

        // Keeper is NOT a constructor arg: the account reads defaultKeeper from
        // this factory in its constructor, so the CREATE2 address depends only on
        // (factory, salt, owner) and is stable across keeper rotations.
        SmartAccount sa = new SmartAccount{salt: saltBytes}(ownerAddr);
        account = address(sa);

        emit AccountCreated(account, ownerAddr, defaultKeeper, salt);
    }

    // ─────────────────────────── Read ────────────────────────────────

    /// @notice Compute the deterministic address for a SmartAccount.
    /// @dev For frontend/off-chain use, compute CREATE2 off-chain using:
    ///      address = keccak256(0xff ++ factory ++ salt ++ keccak256(creationCode ++ abi.encode(owner)))[12:]
    ///      The keeper is NOT part of the init code (the account reads it from the
    ///      factory), so the address is independent of the keeper. The
    ///      `accountInitCodeHash` public immutable provides keccak256(creationCode).
    /// @param salt CREATE2 salt.
    /// @param bytecode The full init code: creationCode ++ abi.encode(owner).
    /// @return The counterfactual address.
    function getAddress(
        bytes32 salt,
        bytes calldata bytecode
    ) public view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(bytecode)
            )
        );
        return address(uint160(uint256(hash)));
    }

    // ─────────────────────────── Admin ───────────────────────────────

    function setDefaultKeeper(address _keeper) external onlyOwner {
        defaultKeeper = _keeper;
        emit DefaultKeeperSet(_keeper);
    }

    function transferFactoryOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }
}
