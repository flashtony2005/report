#!/usr/bin/env bash
#
# 解析「该用哪个 node」。**由 `ts-check.sh` / `ts-project-check.sh` / `ts-test.sh` 共同 source。**
#
# ## 为什么不能像以前那样写死
#
# 这三个脚本原先都把路径写死成 `…/node/versions/22.22.2-2/bin/node`。
# 2026-09-23 环境重新发放，目录名变成 `22.22.2-3`，`-2` 整个消失 ——
# 于是**三个闸同时静默失效**：
#
# - `ts-project-check.sh` 直接 `exit 1`（输出里只有一句「找不到文件」）
# - `ts-check.sh` 更坏：它把「node 不存在」这 2 条当成**类型错误**报出来
#   （`类型错误 2 处`）—— 这是个**假红**，会让人去改本来没错的代码
#
# 版本号后缀是环境发的，不是我们能控制的常量。所以这里**按顺序探测**，
# 探不到就 `return 1`，由调用方**大声失败**（`exit 2` + 一句人话），
# 绝不能让它退化成一个看着像「检查过了」的假结果。
#
# ## 两个实现约束（踩过）
#
# 1. `versions/current` 是个**文本文件**（内容就是版本名），**不是符号链接** ——
#    别写成 `$base/versions/current/bin/node`，那会报 not a directory。
# 2. 本文件会被 `ts-check.sh`（`#!/bin/sh` + `set -e`）source，
#    所以**只能用 POSIX 语法**：不用 `[[ ]]`、不用 `local`，
#    且循环体里不能用 `[ … ] && …` 当最后一句（测试为假时会让 `set -e` 提前退出）。
#    变量统一加 `_nb_` 前缀避免和调用方撞名。

resolve_node() {
  _nb_base="/Users/lushaohui/.workbuddy-ai/binaries/node"

  # 1) 调用方显式指定优先
  if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then
    printf '%s' "$NODE_BIN"
    return 0
  fi

  # 2) versions/current 里写的那个版本
  if [ -f "$_nb_base/versions/current" ]; then
    _nb_v="$(tr -d '[:space:]' < "$_nb_base/versions/current")"
    if [ -n "$_nb_v" ] && [ -x "$_nb_base/versions/$_nb_v/bin/node" ]; then
      printf '%s' "$_nb_base/versions/$_nb_v/bin/node"
      return 0
    fi
  fi

  # 3) 扫 versions/ 兜底（取字典序最后一个）
  _nb_found=""
  for _nb_c in "$_nb_base"/versions/*/bin/node; do
    if [ -x "$_nb_c" ]; then
      _nb_found="$_nb_c"
    fi
  done
  if [ -n "$_nb_found" ]; then
    printf '%s' "$_nb_found"
    return 0
  fi

  # 4) 最后才用 PATH 里的（可能是系统 node，版本不一定合适，所以排最后）
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  return 1
}

# 找不到就退出的公共写法，省得三个脚本各写一遍提示语
require_node() {
  if ! _nb_n="$(resolve_node)"; then
    echo "找不到可用的 node。试过：\$NODE_BIN、versions/current、versions/*/bin/node、PATH。" >&2
    echo "（托管 node 在 ~/.workbuddy-ai/binaries/node/versions/ 下，版本后缀会随环境重发而变。）" >&2
    exit 2
  fi
  printf '%s' "$_nb_n"
}
