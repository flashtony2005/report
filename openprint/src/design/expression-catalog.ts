/**
 * 表达式函数目录 —— 供表达式弹窗（ExpressionModal）展示与插入。
 * 每个条目带中文名 + 说明，用户点击即把 snippet 插入表达式。
 *
 * 说明约定：
 * - snippet 为完整可插入片段（含 {{}} 或裸表达式），直接拼进表达式输入框即可。
 * - 聚合类函数（sum/avg/count/min/max）的路径形如 `'items[].字段'`，
 *   表示对数据根下该数组字段做聚合；必须用引号包住路径字符串。
 * - 函数与过滤器（| currency 等）由 @/core/layout-engine/expression 引擎求值。
 */

export interface ExprFunctionDef {
  /** 唯一 id */
  id: string
  /** 中文名 */
  label: string
  /** 插入到表达式的片段 */
  snippet: string
  /** 作用说明 */
  description: string
  /** 注意事项（可选） */
  note?: string
}

export interface ExprCategory {
  key: string
  label: string
  items: ExprFunctionDef[]
}

export const EXPRESSION_CATALOG: ExprCategory[] = [
  {
    key: 'page',
    label: '页面信息',
    items: [
      {
        id: 'page',
        label: '页码',
        snippet: '{{page}}',
        description: '当前页的页码，从 1 开始。',
      },
      {
        id: 'pages',
        label: '总页数',
        snippet: '{{pages}}',
        description: '文档的总页数（最后一页的页码）。',
      },
      {
        id: 'rowIndex',
        label: '行号',
        snippet: '{{rowIndex + 1}}',
        description: '当前数据行的序号（从 1 起），仅在表格 / 标签网格等逐行区域生效。',
      },
    ],
  },
  {
    key: 'datetime',
    label: '日期时间',
    items: [
      {
        id: 'now',
        label: '当前时间',
        snippet: "{{now() | date:'YYYY-MM-DD HH:mm'}}",
        description: '打印 / 导出时的系统日期时间，可接 date 过滤器指定格式。',
      },
      {
        id: 'dateField',
        label: '日期字段格式化',
        snippet: "{{orderDate | date:'YYYY年MM月DD日'}}",
        description: '把日期型字段格式化为指定样式（YYYY 年、MM 月、DD 日、HH 时、mm 分、ss 秒）。',
        note: '将 orderDate 换成你的日期字段路径。',
      },
    ],
  },
  {
    key: 'aggregate',
    label: '合计统计',
    items: [
      {
        id: 'sum',
        label: '求和',
        snippet: "{{sum('items[].amount')}}",
        description: '对数据数组的数值字段求和，常用于明细金额合计。',
        note: "路径须用引号包住，形如 'items[].amount'。",
      },
      {
        id: 'avg',
        label: '平均值',
        snippet: "{{avg('items[].qty')}}",
        description: '对数据数组的数值字段求平均值。',
        note: "路径须用引号包住，形如 'items[].qty'。",
      },
      {
        id: 'count',
        label: '计数',
        snippet: "{{count('items[].qty')}}",
        description: '统计数据数组中的项数（行数）。',
        note: "路径须用引号包住，形如 'items[].qty'。",
      },
      {
        id: 'min',
        label: '最小值',
        snippet: "{{min('items[].amount')}}",
        description: '取数据数组数值字段的最小值。',
        note: "路径须用引号包住，形如 'items[].amount'。",
      },
      {
        id: 'max',
        label: '最大值',
        snippet: "{{max('items[].amount')}}",
        description: '取数据数组数值字段的最大值。',
        note: "路径须用引号包住，形如 'items[].amount'。",
      },
    ],
  },
  {
    key: 'logic',
    label: '逻辑判断',
    items: [
      {
        id: 'if',
        label: '条件 if',
        snippet: "{{if(amount > 100, '大单', '小单')}}",
        description: '条件成立时返回第二参数，否则返回第三参数；与 ?: 等价，函数写法更直观。',
        note: 'amount 换成你的数值字段；条件可用 > < == != 等比较运算符。',
      },
      {
        id: 'notEmpty',
        label: '非空判断',
        snippet: "{{notEmpty(order.no)}}",
        description: '判断值是否「非空」（非 null / 未定义 / 空字符串 / 空数组），返回 true/false。',
        note: "常配合 if 做兜底：if(notEmpty(order.no), order.no, '—')。",
      },
      {
        id: 'isEmpty',
        label: '为空判断',
        snippet: "{{isEmpty(order.no)}}",
        description: '判断值是否为空（null / 未定义 / 空字符串 / 空数组），返回 true/false。',
      },
      {
        id: 'eq',
        label: '相等 eq',
        snippet: "{{eq(status, 'paid')}}",
        description: '判断两值是否相等（宽松比较，数字与字符串可互通），返回 true/false。',
      },
      {
        id: 'and',
        label: '与 and',
        snippet: "{{and(amount > 0, notEmpty(order.no))}}",
        description: '多个条件「同时成立」才返回 true。',
      },
      {
        id: 'or',
        label: '或 or',
        snippet: "{{or(vip === true, amount > 1000)}}",
        description: '多个条件「任一成立」即返回 true。',
      },
      {
        id: 'not',
        label: '取反 not',
        snippet: "{{not(isEmpty(order.no))}}",
        description: '对布尔结果取反（非空等价于 not(isEmpty)）。',
      },
      {
        id: 'contains',
        label: '包含 contains',
        snippet: "{{contains(productName, '特价')}}",
        description: '判断文本是否包含指定子串（或数组是否包含某元素），返回 true/false。',
      },
    ],
  },
  {
    key: 'format',
    label: '文本 / 数值处理',
    items: [
      {
        id: 'currency',
        label: '货币',
        snippet: "{{order.total | currency:'CNY'}}",
        description: '加币种符号并保留两位、加千分位，如 ¥12,800.50。',
      },
      {
        id: 'number',
        label: '千分位',
        snippet: '{{order.total | number:2}}',
        description: '数值加千分位分隔符，可指定小数位。',
      },
      {
        id: 'percent',
        label: '百分比',
        snippet: '{{rate | percent:1}}',
        description: '把小数转为百分比，如 0.125 → 12.5%。',
      },
      {
        id: 'truncate',
        label: '截断',
        snippet: '{{name | truncate:10}}',
        description: '超长文本截断并加省略号，参数为最大字符数。',
      },
      {
        id: 'padStart',
        label: '补零',
        snippet: '{{seq | padStart:3}}',
        description: '序号左侧补零到指定位数，如 7 → 007。',
      },
      {
        id: 'upper',
        label: '转大写',
        snippet: '{{code | upper}}',
        description: '把文本转为大写字母。',
      },
    ],
  },
  {
    key: 'operator',
    label: '运算符与示例',
    items: [
      {
        id: 'concat',
        label: '文本拼接',
        snippet: "{{'单号-' + order.no}}",
        description: '用 + 把字符串 / 字段拼起来，如 "单号-" + order.no。',
      },
      {
        id: 'ternary',
        label: '条件',
        snippet: "{{amount > 100 ? '大单' : '小单'}}",
        description: '三元表达式：条件 ? 为真值 : 为假值。',
      },
      {
        id: 'arith',
        label: '算术',
        snippet: '{{row.qty * row.price}}',
        description: '支持 + - * / % 四则运算与括号；变量需用 row. 前缀。',
      },
    ],
  },
  {
    key: 'table-agg',
    label: '表格聚合（尾行专用）',
    items: [
      {
        id: 'page-sum',
        label: '本页合计',
        snippet: '{{#pageSum}}',
        description: '尾行数值列专用：本页数据行求和，每页合计行都会出现。',
      },
      {
        id: 'page-avg',
        label: '本页平均',
        snippet: '{{#pageAvg}}',
        description: '尾行数值列专用：本页数据行求平均。',
      },
      {
        id: 'page-count',
        label: '本页行数',
        snippet: '{{#pageCount}}',
        description: '尾行数值列专用：本页数据行行数（计数）。',
      },
      {
        id: 'page-cap',
        label: '本页大写金额',
        snippet: '{{#pageCap}}',
        description: '尾行专用：本页合计的人民币大写金额（如 贰万贰仟陆佰伍拾元整）。',
      },
      {
        id: 'total-sum',
        label: '总计',
        snippet: '{{#totalSum}}',
        description: '尾行数值列专用：整表所有数据行求和，仅末页合计行出现。',
      },
      {
        id: 'total-avg',
        label: '总平均',
        snippet: '{{#totalAvg}}',
        description: '尾行数值列专用：整表所有数据行求平均，仅末页出现。',
      },
      {
        id: 'total-count',
        label: '总行数',
        snippet: '{{#totalCount}}',
        description: '尾行数值列专用：整表所有数据行行数，仅末页出现。',
      },
      {
        id: 'total-cap',
        label: '总计大写金额',
        snippet: '{{#totalCap}}',
        description: '尾行专用：整表总计的人民币大写金额，仅末页出现。',
      },
    ],
  },
]
