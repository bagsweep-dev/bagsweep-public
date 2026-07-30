// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {AbstractSigner} from "@openzeppelin/contracts/utils/cryptography/signers/AbstractSigner.sol";
import {SignerECDSA} from "@openzeppelin/contracts/utils/cryptography/signers/SignerECDSA.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {
    PackedUserOperation,
    IEntryPoint
} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ISweepExecutor} from "./interfaces/ISweepExecutor.sol";

/// @dev Minimal view the account needs from its deploying factory.
interface IKeeperSource {
    function defaultKeeper() external view returns (address);
}

/// @title SmartAccount
/// @author BagSweep
/// @notice Lightweight ERC-4337 smart wallet. Holds user tokens and
///         authorizes UserOps signed by either the owner (EOA) or a
///         trusted keeper address. Deployed by SmartAccountFactory.
contract SmartAccount is Account, SignerECDSA {

    /// @dev The user's EOA — always authorized.
    address public owner;

    /// @dev Trusted keeper that can trigger sweeps via UserOps.
    address public keeper;

    /// @dev Address of the factory that deployed this account.
    address public immutable factory;

    /// @dev SweepExecutor address (set by owner for convenience).
    address public sweepExecutor;

    /// @dev Pending owner for the two-step ownership transfer (L-1).
    address public pendingOwner;

    event KeeperSet(address indexed keeper);
    event SweepExecutorSet(address indexed executor);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwnerOrSelf() {
        require(msg.sender == owner || msg.sender == address(this), "not owner");
        _;
    }

    constructor(address _owner) SignerECDSA(_owner) {
        owner = _owner;
        factory = msg.sender;
        // Read the keeper from the deploying factory in the constructor BODY, not
        // as a constructor arg, so it is excluded from the CREATE2 init code. The
        // account address then depends only on (factory, salt, owner): rotating the
        // factory's default keeper can never change a counterfactual address or
        // strand deposits already sent to it. The owner can rotate per-account
        // afterward via setKeeper.
        keeper = IKeeperSource(msg.sender).defaultKeeper();
    }

    // ───────────────────── Signature Validation ──────────────────────

    /// @dev Owner-only raw signature check. This backs ERC-1271 (isValidSignature)
    ///      and the owner UserOp path. The keeper is intentionally NOT accepted
    ///      here: keeper authority is granted solely in {_validateUserOp}, and only
    ///      for a single sweep call (see {_isAllowedKeeperCall}). Accepting the
    ///      keeper here would make it a general signer for the account.
    function _rawSignatureValidation(
        bytes32 hash,
        bytes calldata signature
    ) internal view override(AbstractSigner, SignerECDSA) returns (bool) {
        return super._rawSignatureValidation(hash, signature);
    }

    /// @dev UserOp validation. The owner may authorize ANY call. The keeper may
    ///      authorize ONLY `execute(sweepExecutor, 0, executeSweep(...))` — it can
    ///      neither move funds directly, change config, nor call any other target.
    ///      A compromised keeper key is therefore bounded to sweep calls, whose
    ///      amount, token, destination and venues SweepExecutor enforces on-chain
    ///      against the user's policy.
    function _validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        bytes calldata signature
    ) internal view override returns (uint256) {
        bytes32 signable = _signableUserOpHash(userOp, userOpHash);

        // Owner signature → full authority.
        if (_rawSignatureValidation(signable, signature)) {
            return ERC4337Utils.SIG_VALIDATION_SUCCESS;
        }

        // Keeper signature → only a sanctioned sweep call.
        if (_isKeeperSignature(signable, signature) && _isAllowedKeeperCall(userOp.callData)) {
            return ERC4337Utils.SIG_VALIDATION_SUCCESS;
        }

        return ERC4337Utils.SIG_VALIDATION_FAILED;
    }

    /// @dev True iff `signature` is a 65-byte ECDSA signature from the trusted keeper.
    function _isKeeperSignature(
        bytes32 hash,
        bytes calldata signature
    ) internal view returns (bool) {
        if (signature.length != 65 || keeper == address(0)) return false;
        (address recovered, ECDSA.RecoverError err, ) =
            ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == keeper;
    }

    /// @dev True iff callData is exactly `execute(sweepExecutor, 0, executeSweep(...))`.
    ///      Rejects any other target, any ETH value, executeBatch, and any inner
    ///      selector other than SweepExecutor.executeSweep.
    function _isAllowedKeeperCall(bytes calldata callData) internal view returns (bool) {
        if (sweepExecutor == address(0) || callData.length < 4) return false;
        if (bytes4(callData[0:4]) != this.execute.selector) return false;

        (address dest, uint256 value, bytes memory inner) =
            abi.decode(callData[4:], (address, uint256, bytes));

        if (dest != sweepExecutor || value != 0 || inner.length < 4) return false;

        bytes4 innerSelector;
        assembly {
            innerSelector := mload(add(inner, 0x20))
        }
        return innerSelector == ISweepExecutor.executeSweep.selector;
    }

    // ─────────────────────────── Execute ─────────────────────────────

    /// @notice Execute an arbitrary call. Callable by the owner directly or
    ///         through the EntryPoint (via UserOp).
    function execute(
        address dest,
        uint256 value,
        bytes calldata data
    ) external payable onlyEntryPointOrSelf returns (bytes memory) {
        (bool ok, bytes memory result) = dest.call{value: value}(data);
        require(ok, "execution failed");
        return result;
    }

    /// @notice Batch execute for gas efficiency.
    function executeBatch(
        address[] calldata dests,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external payable onlyEntryPointOrSelf returns (bytes[] memory results) {
        require(dests.length == values.length && values.length == datas.length, "length mismatch");
        results = new bytes[](dests.length);
        for (uint256 i = 0; i < dests.length; i++) {
            (bool ok, bytes memory result) = dests[i].call{value: values[i]}(datas[i]);
            require(ok, "batch execution failed");
            results[i] = result;
        }
    }

    // ─────────────────────── Owner escape hatch ──────────────────────

    /// @notice Direct owner-controlled execution that does NOT depend on the
    ///         EntryPoint, a bundler, a paymaster, or the keeper. The account owner
    ///         can always act on their own funds through this path, so a compromised
    ///         keeper, a broken or paused EntryPoint, a censoring bundler, or a
    ///         depleted paymaster can never trap a user's assets. This is the
    ///         account's unconditional exit: to withdraw, the owner calls
    ///         `ownerExecute(token, 0, transfer(owner, balance))` directly from
    ///         their EOA. It grants no new authority (the owner already has full
    ///         authority via UserOps); it only removes the 4337 stack as a
    ///         dependency of exiting.
    function ownerExecute(
        address dest,
        uint256 value,
        bytes calldata data
    ) external onlyOwnerOrSelf returns (bytes memory) {
        (bool ok, bytes memory result) = dest.call{value: value}(data);
        require(ok, "owner exec failed");
        return result;
    }

    /// @notice Batch variant of {ownerExecute}, for exiting several assets at once.
    function ownerExecuteBatch(
        address[] calldata dests,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external onlyOwnerOrSelf returns (bytes[] memory results) {
        require(dests.length == values.length && values.length == datas.length, "length mismatch");
        results = new bytes[](dests.length);
        for (uint256 i = 0; i < dests.length; i++) {
            (bool ok, bytes memory result) = dests[i].call{value: values[i]}(datas[i]);
            require(ok, "owner batch failed");
            results[i] = result;
        }
    }

    // ─────────────────────────── Config ──────────────────────────────

    /// @notice Update the trusted keeper address (owner only).
    function setKeeper(address _keeper) external onlyOwnerOrSelf {
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    /// @notice Set the sweep executor address (owner only).
    function setSweepExecutor(address _executor) external onlyOwnerOrSelf {
        sweepExecutor = _executor;
        emit SweepExecutorSet(_executor);
    }

    /// @notice Start a two-step ownership transfer to a new EOA (owner only). The new owner
    ///         must call {acceptOwnership}, so a mistyped address cannot brick the owner path. (L-1)
    function transferOwnership(address newOwner) external onlyOwnerOrSelf {
        require(newOwner != address(0), "zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Complete the two-step ownership transfer; callable only by the pending owner.
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
        _setSigner(owner);
    }

    // ─────────────────────────── Overrides ───────────────────────────

    /// @notice The EntryPoint this account trusts. Pinned to the canonical
    ///         ERC-4337 v0.8 deployment that the rest of the protocol targets
    ///         (the deploy script, the SweepPaymaster, and the EntryPoint at
    ///         0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108). OpenZeppelin's
    ///         Account base defaults `entryPoint()` to v0.9, so without this
    ///         override the account would authorize a different EntryPoint than
    ///         the one every UserOp is routed through, and validation would
    ///         revert for the owner and keeper paths alike.
    function entryPoint() public pure override returns (IEntryPoint) {
        return ERC4337Utils.ENTRYPOINT_V08;
    }

    function signer() public view override returns (address) {
        return owner;
    }

    receive() external payable override {}
}
