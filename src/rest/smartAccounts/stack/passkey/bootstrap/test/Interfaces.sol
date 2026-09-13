// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface PasskeyVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function projectRoot() external view returns (string memory);
    function etch(address target, bytes calldata code) external;
    function deal(address target, uint256 amount) external;
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function signP256(uint256 key, bytes32 digest) external pure returns (bytes32, bytes32);
    function toBase64URL(bytes calldata data) external pure returns (string memory);
    function warp(uint256 timestamp) external;
    function chainId(uint256 chain) external;
    function fee(uint256 basefee) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

struct PasskeyUserOp {
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

struct PasskeyModuleInit {
    address module;
    bytes initData;
    uint256 moduleType;
}

interface PasskeyFactory {
    function createSigner(uint256 x, uint256 y, uint176 verifiers) external returns (address);
    function getSigner(uint256 x, uint256 y, uint176 verifiers) external view returns (address);
    function SINGLETON() external view returns (address);
}

interface PasskeySafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address paymentReceiver
    ) external;
    function domainSeparator() external view returns (bytes32);
    function nonce() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function swapOwner(address previousOwner, address oldOwner, address newOwner) external;
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external returns (bool);
}

interface PasskeySafeFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 salt)
        external
        returns (address);
}

interface PasskeyLaunchpad {
    function addSafe7579(
        address adapter,
        PasskeyModuleInit[] calldata modules,
        address[] calldata attesters,
        uint8 threshold
    ) external;
}

interface PasskeyAdapter {
    function getSafeOp(PasskeyUserOp calldata op, address entryPoint)
        external
        view
        returns (bytes memory operationData, uint48 validAfter, uint48 validUntil, bytes memory signatures);
}

interface PasskeyEntryPoint {
    function handleOps(PasskeyUserOp[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PasskeyUserOp calldata op) external view returns (bytes32);
    function depositTo(address account) external payable;
}
