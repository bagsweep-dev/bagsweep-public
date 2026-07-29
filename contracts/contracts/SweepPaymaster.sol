// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    IPaymaster,
    PackedUserOperation,
    IEntryPoint
} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";

/// @title SweepPaymaster (verifying)
/// @author BagSweep
/// @notice Protocol-funded ERC-4337 paymaster that sponsors a UserOp ONLY when it
///         carries a valid signature from the protocol's off-chain `sponsorSigner`
///         over that exact UserOp. The signer's backend (the keeper service) decides
///         which ops to sponsor and enforces rate limits off-chain, so the shared
///         deposit cannot be drained by arbitrary on-chain callers: an unsigned or
///         wrongly-signed op is rejected, and every sponsored op is one the backend
///         explicitly authorized.
/// @dev    Verifying-paymaster pattern (eth-infinitism style). Validation reads NO
///         external contract storage and uses no banned opcodes: the [validAfter,
///         validUntil] window is supplied in `paymasterAndData` and returned via
///         `validationData` for the EntryPoint to enforce (the paymaster never reads
///         `block.timestamp`), keeping validation within ERC-7562 rules.
///
///         paymasterAndData layout (EntryPoint v0.7/0.8):
///           [0:20]   paymaster address
///           [20:36]  paymasterVerificationGasLimit
///           [36:52]  paymasterPostOpGasLimit
///           [52:58]  validUntil  (uint48, big-endian)
///           [58:64]  validAfter  (uint48, big-endian)
///           [64:]    sponsor signature (65-byte ECDSA)
///
///         RESIDUAL: the sponsor key is trusted. If it leaks, an attacker can get
///         ops sponsored up to `maxCostPerOp` each until the key is rotated; keep it
///         hot-but-guarded in the sponsor backend and rotate via {setSponsorSigner}.
contract SweepPaymaster is IPaymaster, Ownable {

    /// @dev Offset of the paymaster's own data (after addr + the two gas limits).
    uint256 private constant PAYMASTER_DATA_OFFSET = 52;
    /// @dev Offset of the sponsor signature (after validUntil + validAfter).
    uint256 private constant SIGNATURE_OFFSET = 64;

    /// @dev The canonical EntryPoint (v0.8).
    IEntryPoint public immutable entryPoint;

    /// @dev Address whose signature authorizes sponsorship. Its private key lives in
    ///      the sponsor backend (the keeper service), never on-chain.
    address public sponsorSigner;

    /// @dev Total gas cost sponsored (for accounting).
    uint256 public totalGasSponsored;

    /// @dev Hard ceiling on the gas cost of a single sponsored UserOp.
    uint256 public maxCostPerOp;

    error NotEntryPoint();
    error CostTooHigh();

    event SponsorSignerSet(address indexed signer);

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        _;
    }

    constructor(address _entryPoint, address initialOwner) Ownable(initialOwner) {
        entryPoint = IEntryPoint(_entryPoint);
        maxCostPerOp = 0.01 ether; // default safety ceiling
    }

    // ─────────────────────────── Validation ──────────────────────────

    /// @inheritdoc IPaymaster
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 maxCost
    ) external view override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        // Hard ceiling on per-op cost (belt-and-suspenders; the signer also bounds it).
        if (maxCost > maxCostPerOp) revert CostTooHigh();

        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            _parsePaymasterAndData(userOp.paymasterAndData);

        // Recover the sponsor signature over this exact op + window. A wrong or
        // malformed signature yields sigFailed via `validationData` rather than a
        // revert, so bundler simulation can distinguish a rejected sponsorship from
        // a paymaster fault.
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecoverCalldata(hash, signature);
        bool sigOk = (err == ECDSA.RecoverError.NoError && recovered == sponsorSigner && recovered != address(0));

        context = abi.encode(userOp.sender, maxCost);
        validationData = ERC4337Utils.packValidationData(sigOk, validAfter, validUntil);
    }

    /// @notice The digest the `sponsorSigner` signs. It binds the sponsorship to this
    ///         exact UserOp (sender, nonce, init/call data, account + paymaster gas,
    ///         fees), to THIS paymaster and chain, and to the [validAfter, validUntil]
    ///         window, so a sponsorship signature cannot be replayed onto a different
    ///         op, paymaster, or chain.
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[20:PAYMASTER_DATA_OFFSET])), // paymaster gas limits
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function _parsePaymasterAndData(bytes calldata pnd)
        internal
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        validUntil = uint48(bytes6(pnd[PAYMASTER_DATA_OFFSET:PAYMASTER_DATA_OFFSET + 6]));
        validAfter = uint48(bytes6(pnd[PAYMASTER_DATA_OFFSET + 6:SIGNATURE_OFFSET]));
        signature = pnd[SIGNATURE_OFFSET:];
    }

    // ─────────────────────────── Post-Op ─────────────────────────────

    /// @inheritdoc IPaymaster
    function postOp(
        IPaymaster.PostOpMode /*mode*/,
        bytes calldata /*context*/,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) external override onlyEntryPoint {
        // Every mode (op succeeded, op reverted, postOp reverted) still debits the
        // EntryPoint deposit, so count them all: `totalGasSponsored` reflects real
        // outflow rather than only successful spend.
        totalGasSponsored += actualGasCost;
    }

    // ─────────────────────────── Funding ─────────────────────────────

    /// @notice Deposit ETH into the EntryPoint for gas sponsorship.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice Withdraw from the EntryPoint deposit (owner only).
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    /// @notice Add stake to the EntryPoint (required for paymaster reputation).
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    /// @notice Check the paymaster's balance at the EntryPoint.
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    // ─────────────────────────── Admin ───────────────────────────────

    /// @notice Set the sponsor signer whose signature authorizes sponsorship.
    /// @dev    Rotate here if the sponsor key is compromised. Setting address(0)
    ///         disables sponsorship entirely (every op fails signature recovery).
    function setSponsorSigner(address signer) external onlyOwner {
        sponsorSigner = signer;
        emit SponsorSignerSet(signer);
    }

    function setMaxCostPerOp(uint256 _max) external onlyOwner {
        maxCostPerOp = _max;
    }

    receive() external payable {}
}
