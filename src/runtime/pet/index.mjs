// ZCode-Expand 桌宠 · 模块汇总出口
//
// 给 src/runtime/main.mjs 一个 import 点，省得逐个文件 import：
//
//   import { createPetService, createDesktopPet, petPushExpression, petMaskExpression, petPaths,
//            resolvePetAssets, zcodeLogDir, resolvePet, desktopPetAvailability, desktopPetSupported } from './pet/index.mjs';
//
// 每个模块自己的文件头都写了「调用方该怎么用」，从 service.mjs 与 desktop.mjs 看起。

export { createPetService, petPushExpression, petMaskExpression } from './service.mjs';
export { createDesktopPet, desktopWindowOptions, DESKTOP_PET_PARTITION } from './desktop.mjs';
export { petPaths, resolvePetAssets, expandHome } from './assets.mjs';
export { createLogTail, zcodeLogDir, zcodeLogFile } from './log-tail.mjs';
export {
  PET_PROTOCOL_VERSION,
  PET_SCALE,
  PET_SOUNDS,
  desktopPetAvailability,
  desktopPetSupported,
  encodePet,
  decodePet,
  petBase,
  resolvePet,
} from './spec.mjs';
export { createMoodStabilizer, createPetTracker, parseLogLine, parsePromptNotification, PET_MOODS, PET_TIMING } from './mood.mjs';
export { POINTER_TIMING, decidePointer, parsePointerReport, probePoint } from './pointer.mjs';
export {
  DEFAULT_DESKTOP_POSITION,
  boundsFromPosition,
  chooseArea,
  facesLeft,
  parseDesktopPosition,
  positionFromBounds,
  snapToArea,
} from './desktop-position.mjs';
