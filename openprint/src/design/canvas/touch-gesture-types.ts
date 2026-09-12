/** 测试友好的 TouchList 最小结构（避免在纯函数模块引用 DOM 类型） */
export interface TouchLike {
  clientX: number
  clientY: number
}

export interface TouchListLike {
  length: number
  [index: number]: TouchLike
}
