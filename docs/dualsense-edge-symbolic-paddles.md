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

Use the local verifier for private validation:

```bash
node scripts/verify-dualsense-edge-mapping.js
node scripts/verify-dualsense-edge-mapping.js --self-test
node scripts/verify-dualsense-edge-mapping.js --verify-log /path/to/Moonlight.log
```

The log verifier expects Moonlight's existing gamepad mapping log line to show
DualSense Edge VID/PID `0x054c/0x0df2` and `paddle1` through `paddle4` bindings.
Physical validation still has to prove the host receives four separate
paddle/Fn states through Apollo's DualSense Edge path.

## Breakpoint Checks

For a hardware run, put breakpoints on:

- `LiSendControllerArrivalEvent()`
- `LiSendMultiControllerEvent()`

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
