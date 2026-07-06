/** 마우스/키보드가 아니라 터치가 주 입력 수단인 환경(모바일/태블릿) 여부. */
export const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
