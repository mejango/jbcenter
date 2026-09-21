// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CenterSessionGuard, PackedUserOperation} from "../contracts/CenterSessionGuard.sol";

interface Vm {
    function prank(address caller) external;
    function etch(address target, bytes calldata code) external;
}

contract GasOnlySponsorFixture {
    function fixture() external pure returns (bool) {
        return true;
    }
}

contract CenterSessionGuardTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant ID = keccak256("center-session-fixture");
    address private constant ACCOUNT = address(0x123456);
    CenterSessionGuard private guard;
    GasOnlySponsorFixture private sponsor;

    function setUp() public {
        guard = new CenterSessionGuard();
        sponsor = new GasOnlySponsorFixture();
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(config()));
    }

    function config() private view returns (CenterSessionGuard.Config memory) {
        return CenterSessionGuard.Config(
            address(sponsor), address(sponsor).codehash, 1_000_000, 100, 10, 10_000_000, 1_000_000_000, 3, 130
        );
    }

    function operation() private view returns (PackedUserOperation memory op) {
        op.sender = ACCOUNT;
        op.callData = abi.encodeWithSelector(
            guard.EXECUTE_SELECTOR(), bytes32(0), abi.encodePacked(address(0x789), uint256(123), bytes4(0x12345678))
        );
        op.accountGasLimits = bytes32((uint256(100_000) << 128) | 200_000);
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(2) << 128) | 10);
        op.paymasterAndData = abi.encodePacked(
            address(sponsor),
            uint128(30_000),
            uint128(20_000),
            bytes1(0),
            uint48(type(uint48).max),
            uint48(0),
            new bytes(65)
        );
    }

    function assertFailure(PackedUserOperation memory op) private {
        require(guard.checkUserOpPolicy(ID, op) == 1, "expected policy failure");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 0 && costUsed == 0 && callsUsed == 0, "failure mutated counters");
    }

    function testCanonicalSponsorConsumesConservativeCostAndCallCount() public {
        PackedUserOperation memory op = operation();
        require(guard.checkUserOpPolicy(ID, op) == 0, "valid operation rejected");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 400_000 && costUsed == 4_000_000 && callsUsed == 1, "incorrect accounting");
        require(
            guard.checkUserOpPolicy(ID, op) == 0 && guard.checkUserOpPolicy(ID, op) == 0, "remaining calls rejected"
        );
        require(guard.checkUserOpPolicy(ID, op) == 1, "fourth call accepted");
    }

    function testEmptyPaymasterCannotUseAccountNativePrefund() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData = "";
        assertFailure(op);
    }

    function testDifferentPaymasterAndChangedRuntimeFail() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData = abi.encodePacked(address(0x999), uint128(1), uint128(1));
        assertFailure(op);
        op = operation();
        vm.etch(address(sponsor), hex"00");
        assertFailure(op);
    }

    function testMaxFeeIsCappedEvenWhenEffectiveGasPriceCouldBeLow() public {
        PackedUserOperation memory op = operation();
        op.gasFees = bytes32(uint256(type(uint128).max));
        assertFailure(op);
    }

    function testGasPriorityAndSponsorDataBounds() public {
        PackedUserOperation memory op = operation();
        op.preVerificationGas = type(uint256).max;
        assertFailure(op);
        op = operation();
        op.accountGasLimits = bytes32(type(uint256).max);
        assertFailure(op);
        op = operation();
        op.gasFees = bytes32((uint256(11) << 128) | 100);
        assertFailure(op);
        op = operation();
        op.gasFees = bytes32((uint256(10) << 128) | 9);
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(address(sponsor), new bytes(493));
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(address(sponsor), new bytes(31));
        assertFailure(op);
    }

    function testTokenChargingPaymasterModeAndOversizedSignatureFail() public {
        PackedUserOperation memory op = operation();
        op.paymasterAndData[52] = bytes1(0x01);
        assertFailure(op);
        op.paymasterAndData[52] = bytes1(0x03);
        assertFailure(op);
        op = operation();
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, bytes2(0));
        assertFailure(op);
        op = operation();
        require(guard.checkUserOpPolicy(ID, op) == 0, "verifying mode65 rejected");
    }

    function testAlternateExecutionAndNoncanonicalEncodingFail() public {
        PackedUserOperation memory op = operation();
        op.callData = abi.encodeWithSelector(guard.EXECUTE_SELECTOR(), bytes32(uint256(1) << 248), bytes("batch"));
        assertFailure(op);
        op = operation();
        op.callData[4] = bytes1(0xff);
        assertFailure(op);
        op = operation();
        op.callData[0] = bytes1(0xff);
        assertFailure(op);
        op = operation();
        op.callData[67] = bytes1(0x60);
        assertFailure(op);
        op = operation();
        op.callData = abi.encodePacked(op.callData, bytes32(0));
        assertFailure(op);
        op = operation();
        op.callData[op.callData.length - 1] = bytes1(0x01);
        assertFailure(op);
    }

    function testCumulativeLimitsDoNotUseEffectiveGasPrice() public {
        CenterSessionGuard.Config memory limits = config();
        limits.totalSponsoredCostLimit = 7_999_999;
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(limits));
        require(guard.checkUserOpPolicy(ID, operation()) == 0, "first rejected");
        require(guard.checkUserOpPolicy(ID, operation()) == 1, "cost cap exceeded");
        limits = config();
        limits.maxGasPerOperation = 500_000;
        limits.totalGasLimit = 799_999;
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(limits));
        require(guard.checkUserOpPolicy(ID, operation()) == 0, "first gas rejected");
        require(guard.checkUserOpPolicy(ID, operation()) == 1, "gas cap exceeded");
    }

    function testUnauthorizedMultiplexerCannotChangeConfiguredSession() public {
        PackedUserOperation memory op = operation();
        vm.prank(address(0xBAD));
        guard.initializeWithMultiplexer(ACCOUNT, ID, abi.encode(config()));
        vm.prank(address(0xBAD));
        guard.checkUserOpPolicy(ID, op);
        (, uint256 gasUsed,, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 0 && callsUsed == 0, "cross-multiplexer mutation");
        op.sender = address(0xBAD);
        assertFailure(op);
    }

    function testInvalidConfigurationReverts() public {
        CenterSessionGuard.Config memory limits = config();
        limits.paymaster = address(0);
        (bool ok,) =
            address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "zero paymaster accepted");
        limits = config();
        limits.maxGasPerOperation = type(uint256).max;
        limits.totalGasLimit = type(uint256).max;
        (ok,) = address(guard).call(abi.encodeCall(guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encode(limits))));
        require(!ok, "overflow configuration accepted");
        (ok,) = address(guard)
            .call(
                abi.encodeCall(
                    guard.initializeWithMultiplexer, (ACCOUNT, ID, abi.encodePacked(abi.encode(config()), bytes1(0)))
                )
            );
        require(!ok, "trailing config accepted");
    }

    function testFuzzOnlyCanonicalSponsorCanPass(uint256 fee, uint256 preVerificationGas, address paymaster) public {
        PackedUserOperation memory op = operation();
        op.gasFees = bytes32(fee);
        op.preVerificationGas = preVerificationGas;
        op.paymasterAndData = abi.encodePacked(
            paymaster, uint128(30_000), uint128(20_000), bytes1(0), uint48(type(uint48).max), uint48(0), new bytes(65)
        );
        uint256 result = guard.checkUserOpPolicy(ID, op);
        if (result == 0) {
            require(paymaster == address(sponsor), "unapproved sponsor");
            require(uint128(fee) > 0 && uint128(fee) <= 100 && uint128(fee >> 128) <= 10, "unbounded fee");
            require(preVerificationGas <= 650_000, "unbounded gas");
        }
    }

    function testFuzzAcceptedGasUsesRawMaxFee(uint64 seedFee, uint64 seedGas) public {
        PackedUserOperation memory op = operation();
        uint256 maxFee = uint256(seedFee) % 100 + 1;
        op.gasFees = bytes32(maxFee);
        op.preVerificationGas = uint256(seedGas) % 500_001;
        require(guard.checkUserOpPolicy(ID, op) == 0, "bounded operation rejected");
        (, uint256 gasUsed, uint256 costUsed, uint128 callsUsed) = guard.getConfig(ID, address(this), ACCOUNT);
        require(gasUsed == 350_000 + op.preVerificationGas, "gas fields omitted");
        require(costUsed == gasUsed * maxFee && callsUsed == 1, "conservative fee or count mismatch");
    }
}
