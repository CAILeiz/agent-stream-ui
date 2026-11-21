import '@testing-library/jest-dom/vitest'

// jsdom 没有实现 scrollIntoView，贴底滚动相关的断言会炸
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {}
}
