import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'

import { RULE_KIND_LABEL } from '#shared/contract/subscription.ts'
import type { Subscription } from '#shared/contract/subscription.ts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

const VERDICT: Record<'pass' | 'blocked' | 'held', { text: string; variant: 'default' | 'destructive' | 'secondary' }> =
  {
    pass: { text: '通过', variant: 'default' },
    blocked: { text: '拦下', variant: 'destructive' },
    held: { text: '免扰挂起', variant: 'secondary' },
  }

/** 样本测试框：贴一段文本，看命中了哪些规则、最终判定是什么。只读，不落库 */
export function RuleTester(props: { subs: Subscription[] }) {
  const [sample, setSample] = useState('')
  const [uid, setUid] = useState('global')

  const test = useMutation({
    mutationFn: () => api.testRules({ sample, uid: uid === 'global' ? null : uid }),
    onError: (err: Error) => toast.error('试跑失败', { description: err.message }),
  })

  const r = test.data
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="sample" className="text-sm font-medium">
            样本测试
          </Label>
          <Select value={uid} onValueChange={setUid}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">按全局规则</SelectItem>
              {props.subs.map((s) => (
                <SelectItem key={s.uid} value={s.uid}>
                  按 {s.name} 的规则
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Textarea
          id="sample"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          placeholder="贴一段动态正文 / 视频标题 / 简介"
          rows={3}
        />

        <Button
          size="sm"
          onClick={() => test.mutate()}
          disabled={test.isPending || sample.trim() === ''}
        >
          {test.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          试一下
        </Button>

        {r !== undefined && (
          <div className="space-y-2 border-t pt-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={VERDICT[r.verdict.kind].variant}>
                {VERDICT[r.verdict.kind].text}
              </Badge>
              {r.verdict.kind !== 'pass' && (
                <span className="text-muted-foreground text-xs">{r.verdict.reason}</span>
              )}
            </div>

            {r.hits.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                一条规则都没命中（生效的规则 {r.used.length} 条）
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {r.hits.map((h) => (
                  <li key={h.id} className="flex items-center gap-2">
                    <span className="bg-brand size-1.5 rounded-full" aria-hidden />
                    <span>{h.label}</span>
                    {h.timedOut && <Badge variant="outline">超时，不计命中</Badge>}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-muted-foreground text-xs">
              生效的是{' '}
              {r.used.length === 0
                ? '空规则集'
                : r.used.map((u) => `${RULE_KIND_LABEL[u.kind]}「${u.pattern}」`).join('、')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
