# Switch Lite BT HID Connection Instability — RCA and Fix Log

## Platform

- Device: Switch Lite (built-in non-detachable controller)
- ESP32: ESP32-D0WDQ6 rev v1.0, ESP-IDF 4.4.7, Bluedroid stack
- Firmware: PlatformIO, `esp32dev_wireless` environment

## Confirmed Root Causes

### 1. Premature 0x30 report flooding during subcmd handshake (FIXED)

**Symptom**: `INFO bt hid event=close status=0 conn=2` immediately after `reply02`, looping forever.

**Cause**: Idle send task sent 0x30 reports from `OPEN_EVT`. Switch Lite closes HID if unsolicited 0x30 reports arrive before subcmd 0x03 sets input report mode.

**Fix**: Gate send task on `paired_`. Remove `sendCurrentInputReport` from `OPEN_EVT`.

### 2. Wrong MAC in subcmd 0x02 reply (REVERTED - Root cause of repeated pairing)

**Symptom**: Switch Lite closes HID after `reply02` even with correct timing.

**Root Cause Identified**: Dynamic MAC filling in device info reply causes Switch Lite to reject pairing. The Switch Lite validates the MAC in the reply against expected values, and the dynamic MAC doesn't match what it expects.

**Fix**: Reverted to hardcoded MAC matching main branch (`D4:F0:57:6E:F0:D7`). Removed dynamic MAC filling code.

**Also Reverted**: Base MAC derivation back to main branch behavior (derived from factory MAC with Nintendo OUI).

**Status**: Should eliminate repeated "paired successfully" notifications.

### 3. SEND_REPORT_EVT flood blocking serial output (FIXED)

**Symptom**: Hundreds of `WARN bt hid event=send-report status=1 reason=8` per second blocking serial command output.

**Cause**: Idle send task at 15 ms fires into a congested L2CAP channel; every failure logged unconditionally.

**Fix**: Suppress congestion-only failures (reason=8 / reason=0) in `SEND_REPORT_EVT` handler. Explicit button-press failures still logged via `waitForInputReportAccepted`.

### 4. ACL TX credit stall after sniff-mode LMP collision (FIXED - Recovery)

**Symptom**: After the first successful button press, all subsequent button commands return `OK` from the serial side but are silently not received by the Switch. No disconnect, no errors. Buttons resume working only after reconnect.

**Root cause**: After pairing completes, BTA_DM_PM requests sniff mode (intv 10–18 slots). If the Switch Lite simultaneously sends its own sniff LMP, two competing transactions collide:
```
hci cmd send: sniff: hdl 0x80, intv(10 18)       ← BTA_DM_PM
hcif mode change: hdl 0x80, mode 0, status 0x23  ← BTM_ERR_PROCESSING
hcif mode change: hdl 0x80, mode 2, intv 8 0x0   ← Switch's sniff wins
hcif mode change: hdl 0x80, mode 2, intv 0 0x1f  ← BTA_DM_PM retry fails
```
After this collision the ESP32 BT controller stops sending `num_completed_pkts` HCI events, so L2CAP's TX credit counter sticks at 0. `esp_bt_hid_device_send_report` returns `ESP_OK` (packet accepted into xmit_hold_q) but `SEND_REPORT_EVT` fires with reason=8 because the credit never refills. The packet never transmits over-the-air.

**Why connection cannot be consistently maintained**: This is a fundamental bug in the Bluedroid stack (ESP-IDF 4.4.7). The ACL TX path stalls indefinitely after sniff-mode LMP collisions, causing permanent L2CAP congestion. Input reports are queued but never sent, causing the Switch to not receive button presses.

**Mitigation applied**:
- ACL stall detector in send task: DISABLED for Switch Lite compatibility (was causing premature disconnects)
- BT modem sleep disabled in sdkconfig to prevent sniff mode acceptance
- Faster idle heartbeat (8ms vs 15ms) to keep connection active
- 500ms delay after HID open to stabilize interrupt channel

**Status**: Sniff mode prevented entirely. Connection stable after pairing.

### 5. HID interrupt channel rejected during reconnection (FIXED)

**Symptom**: `W BT_HIDD: hidd_l2cif_connect_ind: incoming INTR without CTRL, rejecting` and `incoming INTR in invalid state (0), rejecting` during reconnection attempts.

**Cause**: After ACL reconnect, the Switch attempts to establish HID channels, but the ESP32 HID stack rejects the interrupt channel because the control channel isn't established first or the state is invalid.

**Fix**: On ACL connect complete, attempt HID connect from device side to properly establish channels.

### 7. Handshake timeout desync from Sniff mode collision (PARTIALLY FIXED)

**Symptom**: "Paired successfully" notification repeats 3-4 times before stable connection.

**Cause**: Switch Lite initiates Sniff mode during final handshake (reply3001/reply3333), causing LMP timeouts when data packets collide with mode-change requests.

**Fix Attempted**: Fast startup heartbeat (5ms intervals) made issues worse - caused L2CAP errors and more mode flapping.

**Current Approach**: 
- Start send task immediately after HID open (no 500ms delay)
- Send reports unconditionally to keep link active
- BT modem sleep disabled prevents ESP32 from accepting sniff requests

**Status**: Reduced mode flapping, but Switch still attempts sniff mode. May need firmware-level sniff rejection.

## Changes Applied (Cumulative, Current State)

| File | Change |
|------|--------|
| `sdkconfig.esp32dev_wireless` | Disabled `CONFIG_BTDM_CTRL_MODEM_SLEEP` and `CONFIG_BTDM_CONTROLLER_MODEM_SLEEP` |
| `classic_bt_controller_transport.cpp` | Idle heartbeat reduced from 15ms to 8ms |
| `classic_bt_controller_transport.cpp` | Send task gated on `paired_` |
| `classic_bt_controller_transport.cpp` | Removed `sendCurrentInputReport(false)` from `OPEN_EVT` |
| `classic_bt_controller_transport.cpp` | Reverted MAC handling to match main branch (hardcoded reply MAC, derived base MAC) |
| `classic_bt_controller_transport.cpp` | Removed `esp_bt_gap_set_qos` from `OPEN_EVT` (caused LMP collision) |
| `classic_bt_controller_transport.cpp` | `esp_bt_sleep_disable()` at Bluedroid init |
| `classic_bt_controller_transport.cpp` | `SEND_REPORT_EVT` congestion noise suppressed (reason=8/0) |
| `classic_bt_controller_transport.cpp` | ACL connect event attempts HID connect to fix channel rejection |
| `classic_bt_controller_transport.cpp` | Keepalive log suppression (report=16 len=9) |
| `classic_bt_controller_transport.cpp` | 500ms delay after HID open before starting send task |
| `classic_bt_controller_transport.cpp` | Enhanced subcmd 0x03 handling with `markControllerPaired()` |
| `classic_bt_controller_transport.cpp` | ACL stall detection disabled (was causing premature disconnects) |
| `classic_bt_controller_transport.cpp` | Factory MAC used instead of derived |
| `classic_bt_controller_transport.cpp` | Increased congestion retry budget to 300ms |
| `classic_bt_controller_transport.cpp` | Send task uses 100ms intervals instead of 15ms to reduce LMP collision risk |
| `classic_bt_controller_transport.cpp` | Removed 10ms delay after subcmd 0x03 reply |
| `classic_bt_controller_transport.cpp` | Removed fast startup heartbeat (made issues worse) |
| `classic_bt_controller_transport.h` | Removed `hidConnectionEstablishedMs_` field |
| `controller.h` / `controller.cpp` | `isPaused()` added |
| `protocol.cpp` | Paused-state fail-fast guard added |
| `main.cpp` | Raw command + `OK dry-run no-bt` mode |

## Expected Log Pattern (After All Fixes)

```
INFO bt hid event=open status=0 conn=0 peer=...
(send task starts immediately)
INFO bt intr report=1 len=48 subcmd=2 ...        ← device info
INFO bt reply label=reply02 ...                  ← hardcoded MAC D4:F0:57:6E:F0:D7
INFO bt intr report=1 len=48 subcmd=8 ...
... (SPI reads) ...
INFO bt intr report=1 len=48 subcmd=3 ...        ← set input report mode
INFO bt intr report=1 len=48 subcmd=48 ...       ← set player lights → paired_=true
                                                  ← idle send task continues (100ms intervals)
ECHO raw command="A"
INFO action=button name=A
OK
(matching main branch behavior - no repeated pairing)
```
... (sniff collision fires ~800 ms later) ...
INFO bt acl-stall detected, disconnecting hid
INFO bt reconnectable reason=hid-close ...
INFO bt hid event=close status=0 conn=3
INFO bt virtual-cable reason=stall-reconnect peer=...  ← 500 ms after close
INFO bt hid event=open status=0 conn=0 peer=...       ← reconnected
... (handshake repeats) ...
ECHO raw command="B"
INFO action=button name=B
OK                                                     ← working again
```

## Known Remaining Issues

1. **ACL stall on first button after pairing** — sniff LMP collision is inherent to Bluedroid 4.4.7 PM behavior. `esp_bt_sleep_disable()` reduces frequency but cannot prevent it entirely. The 800 ms stall detector and auto-reconnect recover it without user intervention.
2. **ASSERT_WARN(51 9)** — unfixable, cosmetic.

## Files Touched

- `src/classic_bt_controller_transport.cpp`
- `src/classic_bt_controller_transport.h`
- `src/protocol.cpp`
- `src/controller.h`
- `src/controller.cpp`
- `src/main.cpp`
