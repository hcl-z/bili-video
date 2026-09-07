import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn 生成的组件都靠它合并 class；别改签名。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
