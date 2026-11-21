/**
 * The bundled evidence-pack samples: one deliberately fuzzy draft per
 * technical domain, in the shape users actually write. The pack exists to
 * answer "did optimization help, on this route, right now?" — every sample
 * runs through one rewrite round plus one judge round that scores the raw
 * draft against the rewrite. Pure data and pure selection only — the service
 * owns the rounds.
 * @module @yimiliya/dsh-prompt-optimizer
 */

/** One bundled evidence-pack sample. */
export interface EvalSample {
  /** Stable sample id, for result rows and diagnostics. */
  readonly id: string
  /** Technical domain bucket the sample belongs to, matching the domain-prior ids. */
  readonly domain: string
  /** Complete fuzzy draft text in the shape a user would actually send. */
  readonly draft: string
}

/**
 * The bundled samples, domain-interleaved so every prefix of the pack covers
 * as many domains as it can. Twelve samples: two per domain bucket.
 */
export const EVAL_SAMPLES: readonly EvalSample[] = [
  { id: 'embedded-uart', domain: 'embedded', draft: '帮我看下板子上的串口为什么不收数，发的数据是对的' },
  { id: 'systems-build', domain: 'systems', draft: '编译过的工程换台机器就链接不过，帮我查一下原因' },
  { id: 'frontend-form', domain: 'frontend', draft: '登录页的表单校验有点乱，帮我整理一下，报错提示也要好看点' },
  { id: 'backend-api', domain: 'backend', draft: '给用户列表加个分页接口，现在一次全返回太慢了' },
  { id: 'data-ml-train', domain: 'data-ml', draft: '训练脚本的loss降不下去，帮我看看是不是数据预处理有问题' },
  { id: 'embedded-driver', domain: 'embedded', draft: '写个i2c传感器的读取驱动，要能拿到寄存器的原始值' },
  { id: 'systems-boot', domain: 'systems', draft: '服务重启之后内存涨得很快，帮我定位一下是哪里在漏' },
  { id: 'frontend-theme', domain: 'frontend', draft: '把设置页改成深色模式能跟随系统切换的那种' },
  { id: 'backend-migration', domain: 'backend', draft: '用户表要加个字段，老数据要平滑迁过去，不能停机' },
  { id: 'data-ml-eval', domain: 'data-ml', draft: '模型训完了但不知道效果好不好，帮我搭个评测的流程' },
  { id: 'general-script', domain: 'general', draft: '帮我写个脚本把目录里的图片按拍摄日期整理到子文件夹' },
  { id: 'general-review', domain: 'general', draft: '看一下这个仓库的代码质量怎么样，给我一份能改进的清单' },
]

/** Largest sample count one evidence run accepts. */
export const EVAL_MAX_SAMPLES = 6

/**
 * Select the samples one evidence run carries: the first `count` entries of
 * the domain-interleaved pack, deterministic run over run.
 * @param count - requested sample count, already bounds-checked by the caller.
 * @returns exactly `count` samples in pack order.
 */
export function selectEvalSamples(count: number): readonly EvalSample[] {
  return EVAL_SAMPLES.slice(0, count)
}
