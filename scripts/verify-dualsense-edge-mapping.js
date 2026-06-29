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
const edgePaddleMask = 0x000f0000;
const expectedPaddlePresses = [
  ['PADDLE1/SDL right primary paddle', 0x00010000],
  ['PADDLE2/SDL left primary paddle', 0x00020000],
  ['PADDLE3/SDL right secondary paddle/right Fn', 0x00040000],
  ['PADDLE4/SDL left secondary paddle/left Fn', 0x00080000],
];

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

function readFileOrFail(filePath, label) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(`unable to read ${label} ${filePath}: ${err.message}`);
  }
}

function parseInteger(value) {
  const normalized = value.toLowerCase();
  return Number.parseInt(normalized, normalized.startsWith('0x') ? 16 : 10);
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
  const lldbBreakpoints = readText('scripts/dualsense-edge-lldb-breakpoints.lldb');

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
  assertMatch(
    lldbBreakpoints,
    /breakpoint\s+set\s+--name\s+LiSendControllerArrivalEvent[\s\S]*EDGE_ARRIVAL[\s\S]*supportedButtonFlags[\s\S]*0x000f0000/,
    'LLDB validation helper must inspect controller-arrival supportedButtonFlags'
  );
  assertMatch(
    lldbBreakpoints,
    /breakpoint\s+set\s+--name\s+LiSendMultiControllerEvent[\s\S]*EDGE_MULTI[\s\S]*buttonFlags[\s\S]*0x000f0000/,
    'LLDB validation helper must inspect multi-controller buttonFlags'
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
  const logText = readFileOrFail(logPath, 'log');
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

function analyzeLldbLog(logText) {
  const lines = logText.split(/\r?\n/);
  const arrivalLines = [];
  const multiLines = [];

  for (const line of lines) {
    const arrival = line.match(/\bEDGE_ARRIVAL\b.*\btype=(0x[0-9a-f]+|\d+)\b.*\bsupportedButtonFlags=(0x[0-9a-f]+|\d+)\b.*\bpaddleMask=(0x[0-9a-f]+|\d+)\b.*\bpass=(0x[0-9a-f]+|\d+)\b/i);
    if (arrival) {
      arrivalLines.push({
        line,
        type: parseInteger(arrival[1]),
        supportedButtonFlags: parseInteger(arrival[2]),
        paddleMask: parseInteger(arrival[3]),
        pass: parseInteger(arrival[4]) !== 0,
      });
    }

    const multi = line.match(/\bEDGE_MULTI\b.*\bbuttonFlags=(0x[0-9a-f]+|\d+)\b.*\bpaddleMask=(0x[0-9a-f]+|\d+)\b/i);
    if (multi) {
      multiLines.push({
        line,
        buttonFlags: parseInteger(multi[1]),
        paddleMask: parseInteger(multi[2]),
      });
    }
  }

  const validArrival = arrivalLines.find((arrival) =>
    arrival.pass &&
    arrival.type === 2 &&
    (arrival.supportedButtonFlags & edgePaddleMask) === edgePaddleMask &&
    arrival.paddleMask === edgePaddleMask
  );
  const observedMasks = new Set(multiLines.map((line) => line.paddleMask));
  const missingPresses = expectedPaddlePresses.filter(([, mask]) => !observedMasks.has(mask));
  const allowedMasks = new Set([0, ...expectedPaddlePresses.map(([, mask]) => mask)]);
  const combinedMasks = multiLines.filter((line) => !allowedMasks.has(line.paddleMask));
  const neutralCount = multiLines.filter((line) => line.paddleMask === 0).length;

  return {
    arrivalLines,
    multiLines,
    validArrival,
    missingPresses,
    combinedMasks,
    neutralCount,
    pass: Boolean(validArrival) &&
      missingPresses.length === 0 &&
      combinedMasks.length === 0 &&
      neutralCount >= expectedPaddlePresses.length,
  };
}

function verifyLldbLog(logPath) {
  const logText = readFileOrFail(logPath, 'LLDB log');
  const result = analyzeLldbLog(logText);
  const report = [
    `Moonlight DualSense Edge LLDB breakpoint evidence: ${result.pass ? 'PASS' : 'FAIL'}`,
    `log_path=${logPath}`,
    result.validArrival
      ? `PASS: arrival advertises LI_CTYPE_PS and paddle/Fn mask 0x000f0000: ${result.validArrival.line.trim()}`
      : 'FAIL: no EDGE_ARRIVAL line proved type=2 and paddleMask=0x000f0000',
    ...expectedPaddlePresses.map(([name, mask]) =>
      result.missingPresses.some(([, missingMask]) => missingMask === mask)
        ? `FAIL: missing one-at-a-time ${name} mask 0x${mask.toString(16).padStart(8, '0')}`
        : `PASS: observed one-at-a-time ${name} mask 0x${mask.toString(16).padStart(8, '0')}`
    ),
    result.neutralCount >= expectedPaddlePresses.length
      ? `PASS: observed ${result.neutralCount} neutral paddle/Fn releases`
      : `FAIL: observed ${result.neutralCount} neutral paddle/Fn releases; expected at least ${expectedPaddlePresses.length}`,
    result.combinedMasks.length === 0
      ? 'PASS: no combined paddle/Fn masks during one-at-a-time validation'
      : `FAIL: combined paddle/Fn masks found: ${result.combinedMasks.map((line) => line.line.trim()).join(' | ')}`,
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

  const passingLldbLog = [
    'EDGE_ARRIVAL controller=0 activeMask=0x0001 type=2 supportedButtonFlags=0x003f0000 paddleMask=0x000f0000 pass=1',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00010000 paddleMask=0x00010000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00000000 paddleMask=0x00000000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00020000 paddleMask=0x00020000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00000000 paddleMask=0x00000000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00040000 paddleMask=0x00040000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00000000 paddleMask=0x00000000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00080000 paddleMask=0x00080000',
    'EDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00000000 paddleMask=0x00000000',
  ].join('\n');
  const missingArrivalLldbLog = passingLldbLog.replace('type=2', 'type=0');
  const combinedMaskLldbLog = `${passingLldbLog}\nEDGE_MULTI controller=0 activeMask=0x0001 buttonFlags=0x00030000 paddleMask=0x00030000`;

  if (!analyzeLldbLog(passingLldbLog).pass) {
    fail('self-test expected sample LLDB breakpoint log to pass');
  }
  if (analyzeLldbLog(missingArrivalLldbLog).pass) {
    fail('self-test expected LLDB log without PlayStation arrival to fail');
  }
  if (analyzeLldbLog(combinedMaskLldbLog).pass) {
    fail('self-test expected LLDB log with combined paddle mask to fail');
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  assertSourceLayout();
  console.log('DualSense Edge symbolic paddle verification passed.');
} else if (args[0] === '--verify-log' && args[1]) {
  verifyLog(args[1]);
} else if (args[0] === '--verify-lldb-log' && args[1]) {
  verifyLldbLog(args[1]);
} else if (args[0] === '--self-test') {
  selfTest();
  console.log('DualSense Edge symbolic paddle self-test passed.');
} else {
  console.error('Usage: node scripts/verify-dualsense-edge-mapping.js [--self-test | --verify-log <moonlight.log> | --verify-lldb-log <lldb.log>]');
  process.exit(2);
}
