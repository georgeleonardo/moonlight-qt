# DualSense Edge Symbolic Paddle Evidence

This branch keeps Moonlight's runtime input path aligned with upstream. The
DualSense Edge fix should be host-side: Apollo should use the controller-arrival
packet's PlayStation type plus the four Sunshine paddle flags to choose
DualSense Edge emulation.

Moonlight already maps SDL controller buttons into Sunshine button flags through
`SdlInputHandler::k_ButtonMap`:

- `SDL_CONTROLLER_BUTTON_PADDLE1` -> `PADDLE1_FLAG` (`0x010000`)
- `SDL_CONTROLLER_BUTTON_PADDLE2` -> `PADDLE2_FLAG` (`0x020000`)
- `SDL_CONTROLLER_BUTTON_PADDLE3` -> `PADDLE3_FLAG` (`0x040000`)
- `SDL_CONTROLLER_BUTTON_PADDLE4` -> `PADDLE4_FLAG` (`0x080000`)

Under sdl2-compat/SDL3, those symbols correspond to
`SDL_GAMEPAD_BUTTON_RIGHT_PADDLE1`, `SDL_GAMEPAD_BUTTON_LEFT_PADDLE1`,
`SDL_GAMEPAD_BUTTON_RIGHT_PADDLE2`, and
`SDL_GAMEPAD_BUTTON_LEFT_PADDLE2`. SDL3 documents the DualSense Edge examples
for that order as right primary paddle, left primary paddle, right Fn, and left
Fn. Raw HIDAPI button indices can still differ between SDL2 and SDL3, so the
symbolic SDL button identity is the part Moonlight should preserve.

The same `k_ButtonMap` is used in two places:

- Button events set and clear `state->buttons`, so paddle presses travel in the
  normal multi-controller input packets.
- Controller arrival walks `SDL_GameControllerHasButton()` over `k_ButtonMap`
  and sends `supportedButtonFlags` with `LiSendControllerArrivalEvent()`.

That means Moonlight should not need a DualSense Edge-specific raw HIDAPI
mapping patch as long as SDL exposes the Edge controls as symbolic
`PADDLE1-4` buttons. SDL2 and SDL3 can use different raw button indices; those
indices are an SDL implementation detail once the symbolic button mapping is
correct.

Maintainer feedback on `moonlight-stream/moonlight-qt#1922` confirmed this
direction: the symbolic SDL paddle mappings are the supported Moonlight path,
and the useful client-side validation is to breakpoint
`LiSendControllerArrivalEvent()` and `LiSendMultiControllerEvent()` to confirm
the arrival paddle mask and per-button state transitions. If those checks pass,
the remaining implementation work is host-side.

Use the local verifier for private validation:

```bash
node scripts/verify-dualsense-edge-mapping.js
node scripts/verify-dualsense-edge-mapping.js --self-test
node scripts/verify-dualsense-edge-mapping.js --verify-log /path/to/Moonlight.log
node scripts/verify-dualsense-edge-mapping.js --verify-lldb-log /path/to/lldb-transcript.log
```

The log verifier expects Moonlight's existing gamepad mapping log line to show
DualSense Edge VID/PID `0x054c/0x0df2` and `paddle1` through `paddle4` bindings.
Physical validation still has to prove the host receives four separate
paddle/Fn states through Apollo's DualSense Edge path.

## Breakpoint Checks

For a hardware run, put breakpoints on:

- `LiSendControllerArrivalEvent()`
- `LiSendMultiControllerEvent()`

The helper command file sets both breakpoints and prints the relevant arguments
plus stable `EDGE_ARRIVAL` and `EDGE_MULTI` lines for transcript verification:

```lldb
command source scripts/dualsense-edge-lldb-breakpoints.lldb
```

It auto-continues after printing values. Remove `--auto-continue true` from the
helper if you need the debugger to stop at each call. Save the LLDB console
output and run `--verify-lldb-log` against it; the verifier requires one valid
PlayStation arrival with `paddleMask=0x000f0000`, one-at-a-time press masks for
all four Edge controls, at least four neutral release masks, and no combined
paddle/Fn masks.

On `LiSendControllerArrivalEvent()`, connect the physical DualSense Edge and
check:

- `type == LI_CTYPE_PS`
- `(supportedButtonFlags & 0x000f0000) == 0x000f0000`

On `LiSendMultiControllerEvent()`, press each Edge control one at a time and
check the `buttonFlags` argument:

- PADDLE1 / right rear: `buttonFlags & 0x00010000`
- PADDLE2 / left rear: `buttonFlags & 0x00020000`
- PADDLE3 / right Fn: `buttonFlags & 0x00040000`
- PADDLE4 / left Fn: `buttonFlags & 0x00080000`

Each release should return the corresponding bit to zero before pressing the
next control. If these checks pass in Moonlight, the remaining implementation
work is host-side: Apollo must use the arrival paddle mask to select the
DualSense Edge USB/IP path and then preserve those four bits in the virtual
Edge input report.
