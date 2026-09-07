// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-4337 v0.7 wire type. Field order is part of the policy ABI.
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// @notice A SmartSession IUserOpPolicy for a separately approved gas-only sponsor.
/// @dev Undeployed Center source. Existing action/time policies remain mandatory.
/// This policy never executes calls, transfers funds, or accepts owner signatures.
contract CenterSessionGuard {
    struct Config {
        address paymaster;
        bytes32 paymasterCodeHash;
        uint256 maxGasPerOperation;
        uint256 maxFeePerGas;
        uint256 maxPriorityFeePerGas;
        uint256 totalGasLimit;
        uint256 totalSponsoredCostLimit;
        uint128 maximumCalls;
        uint32 maxPaymasterDataLength;
    }

    struct State {
        Config config;
        uint256 gasUsed;
        uint256 costUsed;
        uint128 callsUsed;
    }

    bytes4 public constant EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));
    uint256 public constant MAX_CALLDATA_LENGTH = 8192;
    uint256 public constant MAX_PAYMASTER_DATA_LENGTH = 130;
    // Config namespace follows the pinned legacy SmartSession policy interfaces.
    mapping(bytes32 id => mapping(address multiplexer => mapping(address account => State))) private _states;

    error InvalidConfiguration();
    event PolicySet(bytes32 id, address multiplexer, address account);

    /// @dev Only the calling multiplexer can change its own configuration namespace.
    /// Owner authorization is enforced by SmartSession's enable/install flow.
    function initializeWithMultiplexer(address account, bytes32 id, bytes calldata data) external {
        if (data.length != 288 || account == address(0)) revert InvalidConfiguration();
        Config memory config = abi.decode(data, (Config));
        if (
            config.paymaster == address(0) || config.paymaster.code.length == 0
                || config.paymaster.codehash != config.paymasterCodeHash || config.maxGasPerOperation == 0
                || config.maxGasPerOperation > type(uint128).max || config.maxGasPerOperation > config.totalGasLimit
                || config.maxFeePerGas == 0 || config.maxFeePerGas > type(uint128).max
                || config.maxPriorityFeePerGas > config.maxFeePerGas || config.totalSponsoredCostLimit == 0
                || config.maximumCalls == 0 || config.maxPaymasterDataLength < 130
                || config.maxPaymasterDataLength > MAX_PAYMASTER_DATA_LENGTH
        ) revert InvalidConfiguration();
        _states[id][msg.sender][account] = State(config, 0, 0, 0);
        emit PolicySet(id, msg.sender, account);
    }

    /// @return validationData 0 for success or 1 for signature/policy failure.
    /// Counters are charged during validation and can remain consumed after a reverted action.
    /// Total cost uses maxFeePerGas, not effective gas price, to bound EntryPoint prefund.
    function checkUserOpPolicy(bytes32 id, PackedUserOperation calldata op) external returns (uint256 validationData) {
        State storage state = _states[id][msg.sender][op.sender];
        Config storage config = state.config;
        if (config.maximumCalls == 0 || state.callsUsed >= config.maximumCalls || !_canonicalSingle(op.callData)) {
            return 1;
        }
        bytes calldata paymasterData = op.paymasterAndData;
        // Legacy Pimlico SingletonPaymasterV7 verifying mode: header52 + mode1 + validity12 + signature65.
        // Its pinned OpenZeppelin ECDSA.recover(bytes) implementation accepts 65-byte signatures only.
        // Byte52 is the direct mode in this deployment; ERC20 mode1 can pull tokens and must be rejected here.
        if (
            paymasterData.length < 130 || paymasterData.length > config.maxPaymasterDataLength
                || uint8(paymasterData[52]) != 0
        ) return 1;
        address paymaster = address(bytes20(paymasterData[:20]));
        if (paymaster != config.paymaster || paymaster.codehash != config.paymasterCodeHash) return 1;

        uint256 maxFee = uint128(uint256(op.gasFees));
        uint256 priorityFee = uint128(uint256(op.gasFees) >> 128);
        if (
            maxFee == 0 || maxFee > config.maxFeePerGas || priorityFee > config.maxPriorityFeePerGas
                || priorityFee > maxFee
        ) {
            return 1;
        }
        // Each packed gas field is uint128; preVerificationGas is the only unbounded field.
        // Check it first so subsequent additions cannot overflow.
        if (op.preVerificationGas > config.maxGasPerOperation) return 1;
        uint256 gas = uint128(uint256(op.accountGasLimits) >> 128) + uint256(uint128(uint256(op.accountGasLimits)))
            + op.preVerificationGas + uint128(bytes16(paymasterData[20:36]))
            + uint256(uint128(bytes16(paymasterData[36:52])));
        if (gas > config.maxGasPerOperation || gas > config.totalGasLimit - state.gasUsed) return 1;
        // Division first makes even adversarial uint256 configurations overflow safe.
        if (gas > (config.totalSponsoredCostLimit - state.costUsed) / maxFee) return 1;
        state.gasUsed += gas;
        state.costUsed += gas * maxFee;
        state.callsUsed += 1;
        return 0;
    }

    function getConfig(bytes32 id, address multiplexer, address account)
        external
        view
        returns (Config memory config, uint256 gasUsed, uint256 costUsed, uint128 callsUsed)
    {
        State storage state = _states[id][multiplexer][account];
        return (state.config, state.gasUsed, state.costUsed, state.callsUsed);
    }

    /// @dev Exactly the canonical ABI encoding of execute(bytes32(0), packed single call).
    /// Excludes batching, delegatecall, try-execute, alternate selectors and ABI aliases.
    function _canonicalSingle(bytes calldata data) private pure returns (bool) {
        if (data.length < 164 || data.length > MAX_CALLDATA_LENGTH || bytes4(data[:4]) != EXECUTE_SELECTOR) {
            return false;
        }
        if (bytes32(data[4:36]) != bytes32(0) || uint256(bytes32(data[36:68])) != 64) return false;
        uint256 size = uint256(bytes32(data[68:100]));
        // 20-byte target + 32-byte value + at least a four-byte inner selector.
        if (size < 56 || size > MAX_CALLDATA_LENGTH - 100 || data.length != 100 + ((size + 31) & ~uint256(31))) {
            return false;
        }
        for (uint256 i = 100 + size; i < data.length; ++i) {
            if (data[i] != 0) return false;
        }
        return true;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // IERC165, pinned IPolicy initializer, and IUserOpPolicy check method.
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x989c9e46 || interfaceId == this.checkUserOpPolicy.selector;
    }
}
