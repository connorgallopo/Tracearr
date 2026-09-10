// The ! important modifier beats DialogContent's own base max-width variant
// without a breakpoint of our own; min-w clamps to the viewport so it still fits a phone.
export const SERVER_DIALOG_CONTENT_CLASS =
  'w-fit max-w-[calc(100vw-2rem)]! min-w-[min(28rem,calc(100vw-2rem))]';
