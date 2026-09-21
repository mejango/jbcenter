// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Deliberately broad adversarial module. The inspector must reject this authority even though
/// the real Safe7579 contract permits an owner to install it under every module type.
contract InspectorAttackModule {
    function isModuleType(uint256) external pure returns (bool) { return true; }
    function onInstall(bytes calldata) external {}
    function onUninstall(bytes calldata) external {}
    function preCheck(address, uint256, bytes calldata) external pure returns (bytes memory) { return ""; }
    function postCheck(bytes calldata) external {}
    function rewriteSingleton(address singleton) external { assembly { sstore(0, singleton) } }
    fallback() external payable {}
}
