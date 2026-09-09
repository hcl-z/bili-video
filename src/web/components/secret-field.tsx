import type { SecretState } from '#shared/contract/api.ts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * 密钥输入框：只写不读。
 *
 * 掩码只出现在 placeholder 和旁边的 Badge 里，绝不作为 value —— 那样一保存就会把
 * 「sk-1****9abc」当成新 key 写回去。后端还有一道同样的防线（domain/secret-write.ts）。
 */
export function SecretField(props: {
  id: string
  label: string
  state: SecretState
  value: string
  onChange: (v: string) => void
  onClear: () => void
  clearing: boolean
}) {
  const { state } = props
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        {state.configured ? (
          <Badge variant="secondary" className="font-mono">
            {state.masked}
          </Badge>
        ) : (
          <Badge variant="outline">未配置</Badge>
        )}
        {state.configured && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={props.onClear}
            disabled={props.clearing}
          >
            清空
          </Button>
        )}
      </div>
      <Input
        id={props.id}
        name={props.id}
        type="password"
        autoComplete="new-password"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={state.configured ? '留空表示不修改' : 'sk-…'}
      />
    </div>
  )
}
