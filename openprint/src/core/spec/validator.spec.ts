import { describe, expect, it } from 'vitest'

import { assertTemplate } from '@/core/spec/validator'
import type { TemplateData } from '@/types/template'

describe('template 协议：常驻辅助线字段', () => {
  const base = {
    version: '1.0',
    document: {
      type: 'report' as const,
      page: {
        width: 210,
        height: 297,
        unit: 'mm' as const,
        orientation: 'portrait' as const,
        margin: { top: 10, bottom: 10, left: 10, right: 10 },
      },
      sections: [
        {
          type: 'body' as const,
          components: [
            {
              id: 'r1',
              type: 'rect' as const,
              left: 10,
              top: 10,
              width: 40,
              height: 25,
            },
          ],
        },
      ],
    },
  }

  it('允许控件带 showGuides 字段', () => {
    const t = {
      ...base,
      document: {
        ...base.document,
        sections: [
          {
            type: 'body' as const,
            components: [
              {
                id: 'r1',
                type: 'rect' as const,
                left: 10,
                top: 10,
                width: 40,
                height: 25,
                showGuides: true,
              },
            ],
          },
        ],
      },
    } as unknown as TemplateData
    expect(() => assertTemplate(t)).not.toThrow()
  })
})
