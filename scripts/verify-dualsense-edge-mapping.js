#!/usr/bin/env node
/*
 * Verifies the minimal DualSense Edge assumption for Moonlight:
 * SDL exposes Edge extras as symbolic controller buttons PADDLE1-4, Moonlight
 * already maps those buttons into Sunshine paddle flags, and Apollo should use
 * those arrival flags to select DualSense Edge emulation on the host.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`DualSense Edge symbolic paddle verification failed: ${message}`);
  process.exit(1);
}

function readText(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    fail(`unable to read ${relativePath}: ${err.message}`);
  }
}

function assertMatch(content, pattern, message) {
  if (!pattern.test(content)) {
    fail(message);
  }
}

function extractButtonMap(gamepadSource) {
  const match = gamepadSource.match(/const\s+int\s+SdlInputHandler::k_ButtonMap\[\]\s*=\s*\{([\s\S]*?)\};/);
  if (!match) {
    fail('SdlInputHandler::k_ButtonMap initializer not found');
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertButtonMapIncludesSymbolicPaddles(gamepadSource) {
  const buttonMap = extractButtonMap(gamepadSource);
  const expectedTail = [
    'MISC_FLAG',
    'PADDLE1_FLAG',
    'PADDLE2_FLAG',
    'PADDLE3_FLAG',
    'PADDLE4_FLAG',
    'TOUCHPAD_FLAG',
  ];
  const tail = buttonMap.slice(-expectedTail.length);
  if (tail.join(',') !== expectedTail.join(',')) {
    fail(`k_ButtonMap must keep MISC, PADDLE1-4, and TOUCHPAD in SDL controller button order; actual tail=${tail.join(',')}`);
  }
}

function assertSourceLayout() {
  const gamepadSource = readText('app/streaming/input/gamepad.cpp');
  const limelightHeader = readText('moonlight-common-c/moonlight-common-c/src/Limelight.h');
  const inputStreamSource = readText('moonlight-common-c/moonlight-common-c/src/InputStream.c');

  assertButtonMapIncludesSymbolicPaddles(gamepadSource);

  assertMatch(
    gamepadSource,
    /if\s*\(\s*event->button\s*>=\s*SDL_arraysize\(k_ButtonMap\)\s*\)[\s\S]*?state->buttons\s*\|=\s*k_ButtonMap\[event->button\]/,
    'controller button presses must be bounded by k_ButtonMap and OR the mapped Sunshine flag'
  );
  assertMatch(
    gamepadSource,
    /state->buttons\s*&=\s*~k_ButtonMap\[event->button\]/,
    'controller button releases must clear the mapped Sunshine flag'
  );
  assertMatch(
    gamepadSource,
    /for\s*\(\s*int\s+i\s*=\s*0;\s*i\s*<\s*\(int\)SDL_arraysize\(k_ButtonMap\);\s*i\+\+\s*\)\s*\{[\s\S]*?SDL_GameControllerHasButton\(state->controller,\s*\(SDL_GameControllerButton\)i\)[\s\S]*?supportedButtonFlags\s*\|=\s*k_ButtonMap\[i\]/,
    'controller arrival must advertise every SDL symbolic button supported by k_ButtonMap'
  );
  assertMatch(
    gamepadSource,
    /case\s+SDL_CONTROLLER_TYPE_PS5:\s*[\r\n\s]*type\s*=\s*LI_CTYPE_PS;/,
    'PS5-class SDL controllers must advertise PlayStation arrival type'
  );
  assertMatch(
    gamepadSource,
    /LiSendControllerArrivalEvent\(state->index,\s*m_GamepadMask,\s*type,\s*supportedButtonFlags,\s*capabilities\);/,
    'controller arrival must send supportedButtonFlags to the host'
  );
  assertMatch(
    gamepadSource,
    /LiSendMultiControllerEvent\(state->index,\s*m_GamepadMask,\s*buttons,\s*lt,\s*rt,\s*lsX,\s*lsY,\s*rsX,\s*rsY\);/,
    'multi-controller packets must send the mapped button flags to the host'
  );
  assertMatch(limelightHeader, /#define\s+PADDLE1_FLAG\s+0x010000\b/, 'PADDLE1 flag must stay in Sunshine high-word bit 0');
  assertMatch(limelightHeader, /#define\s+PADDLE2_FLAG\s+0x020000\b/, 'PADDLE2 flag must stay in Sunshine high-word bit 1');
  assertMatch(limelightHeader, /#define\s+PADDLE3_FLAG\s+0x040000\b/, 'PADDLE3 flag must stay in Sunshine high-word bit 2');
  assertMatch(limelightHeader, /#define\s+PADDLE4_FLAG\s+0x080000\b/, 'PADDLE4 flag must stay in Sunshine high-word bit 3');
  assertMatch(
    inputStreamSource,
    /holder->packet\.controllerArrival\.supportedButtonFlags\s*=\s*LE32\(supportedButtonFlags\);/,
    'Moonlight common must serialize controller-arrival supportedButtonFlags'
  );
}

function analyzeLog(logText) {
  const lines = logText.split(/\r?\n/);
  const edgeMappingLine = lines.find((line) =>
    /Gamepad \d+ .*VID\/PID: 0x054c\/0x0df2/i.test(line) &&
    /mapping: .*paddle1:[^,\s)]+.*paddle2:[^,\s)]+.*paddle3:[^,\s)]+.*paddle4:[^,\s)]+/i.test(line)
  );
  const noMappingLines = lines.filter((line) => /No mapping for gamepad button: (16|17|18|19)\b/.test(line));

  return {
    edgeMappingLine,
    noMappingLines,
    pass: Boolean(edgeMappingLine) && noMappingLines.length === 0,
  };
}

function verifyLog(logPath) {
  let logText;
  try {
    logText = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    fail(`unable to read log ${logPath}: ${err.message}`);
  }

  const result = analyzeLog(logText);
  const report = [
    `Moonlight DualSense Edge symbolic paddle evidence: ${result.pass ? 'PASS' : 'FAIL'}`,
    `log_path=${logPath}`,
    result.edgeMappingLine
      ? `PASS: Edge VID/PID mapping line exposes paddle1-4: ${result.edgeMappingLine.trim()}`
      : 'FAIL: no Moonlight gamepad mapping line found with VID/PID 0x054c/0x0df2 and paddle1-4 bindings',
    result.noMappingLines.length === 0
      ? 'PASS: no missing SDL controller button mapping diagnostics for PADDLE1-4 indices'
      : `FAIL: missing SDL controller button mapping diagnostics found: ${result.noMappingLines.join(' | ')}`,
    '',
    `overall=${result.pass ? 'PASS' : 'FAIL'}`,
  ];

  console.log(report.join('\n'));
  if (!result.pass) {
    process.exit(1);
  }
}

function selfTest() {
  assertSourceLayout();

  const passingLog = 'Gamepad 0 (player 0) is: DualSense Edge Wireless Controller (VID/PID: 0x054c/0x0df2) (haptic capabilities: 0x0) (mapping: 030000004c050000f20d000000000000 -> 030000004c050000f20d000000000000,DualSense Edge,a:b0,b:b1,paddle1:b20,paddle2:b19,paddle3:b18,paddle4:b17,type:ps5,platform:Mac OS X,)';
  const failingLog = 'Gamepad 0 (player 0) is: DualSense Wireless Controller (VID/PID: 0x054c/0x0ce6) (haptic capabilities: 0x0) (mapping: 030000004c050000e60c000000000000 -> 030000004c050000e60c000000000000,DualSense,a:b0,b:b1,type:ps5,platform:Mac OS X,)';
  const missingMappingLog = `${passingLog}\nNo mapping for gamepad button: 16`;

  if (!analyzeLog(passingLog).pass) {
    fail('self-test expected sample Edge mapping log to pass');
  }
  if (analyzeLog(failingLog).pass) {
    fail('self-test expected non-Edge sample log to fail');
  }
  if (analyzeLog(missingMappingLog).pass) {
    fail('self-test expected missing paddle controller-button diagnostic to fail');
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  assertSourceLayout();
  console.log('DualSense Edge symbolic paddle verification passed.');
} else if (args[0] === '--verify-log' && args[1]) {
  verifyLog(args[1]);
} else if (args[0] === '--self-test') {
  selfTest();
  console.log('DualSense Edge symbolic paddle self-test passed.');
} else {
  console.error('Usage: node scripts/verify-dualsense-edge-mapping.js [--self-test | --verify-log <moonlight.log>]');
  process.exit(2);
}
