import { Context, Schema } from 'koishi'
import { promises as fs } from 'fs'
import { resolve, join, extname, basename } from 'path'

export const name = 'picar'

export const inject = {
  required: ['database']
}

export interface ConfigItem {
  command: string,
  url: string,
  template: string
}

// 多组配置：允许可变长度数组
export type Config = ConfigItem[]
export const Config = Schema.object(
  {
    config: Schema.array(
      Schema.object({
        command: Schema.string().default('picar').description('命令名称'),
        url: Schema.string().default('https://example.com').description('图片的URL地址'),
        template: Schema.string().default('{pict}').description('回复消息的模板, {pict} 会被替换为图片'),
      }),
    ).role('table').default([]).description('图片配置列表'),
  })

export function apply(ctx: Context, config: any) {
  // write your plugin here

  const configList: ConfigItem[] = config.config || []
  if (configList.length !== 0) {
    for (let item of configList) {
      ctx.logger.debug(`Registering command: ${item.command} -> ${item.url}`)
      ctx.command(item.command, 'picture car')
        .action(async (session) => {
          ctx.logger.debug(`using command: ${item.command} -> ${item.url}`)
          const msg = await replacePixivPlaceholders(item.template, item.url, ctx.logger)
          // session.send(msg)
          return msg
        })
    }
  }

}


// reference: https://github.com/Koishi-Plugin/best-jrrp/blob/main/src/msgbuilder.ts#L142
/**
 * 获取Pixiv图片链接数组（本地无则自动下载）
 */
async function getPixivLinks(imagesPath, logger): Promise<string[]> {
  // const { baseDir = process.cwd(), imagesPath, logger = console } = this.pixivConfig
  let baseDir = process.cwd()
  if (!imagesPath) return []
  // 判断是本地路径还是URL
  const isLocalPath = !imagesPath.startsWith('http://') && !imagesPath.startsWith('https://');
  if (isLocalPath) {
    // 处理本地目录
    try {
      let dirPath = imagesPath;
      if (!dirPath.startsWith('/') && !dirPath.match(/^[A-Za-z]:\\/)) {
        dirPath = resolve(baseDir, dirPath);
      }
      // 读取目录下所有文件
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      const imageFiles = files
        .filter(file => file.isFile() && /\.(jpe?g|png|gif|webp)$/i.test(file.name))
        .map(file => join(dirPath, file.name));
      return imageFiles;
    } catch (e) {
      logger.error('读取本地图片目录失败:', e);
      return [];
    }
  } else {
    // 处理远程JSON链接
    const { resolve } = await import('path');
    const { existsSync } = await import('fs');
    const { readFile, writeFile } = await import('fs/promises');
    const filename = basename(imagesPath)
    const filePath = resolve(baseDir, 'data', filename);
    if (!existsSync(filePath)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(imagesPath, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`下载失败: ${res.status}`);
        await writeFile(filePath, await res.text(), 'utf8');
      } catch (e) {
        logger.error('下载JSON文件失败:', e);
        return [];
      }
    }
    try {
      const arr = JSON.parse(await readFile(filePath, 'utf8'));
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      logger.error('读取链接失败:', e);
      return [];
    }
  }
}



/**
 * 替换所有Pixiv占位符
 * @private
 * @param {string} template 模板字符串
 * @returns {Promise<string>} 替换后的字符串
 */
async function replacePixivPlaceholders(template: string, url: string, logger): Promise<string> {
  const matches = [...template.matchAll(/{pict}/g)]
  if (!matches.length) return template
  const arr = await getPixivLinks(url, logger)
  const replacements = await Promise.all(matches.map(async m => {
    let content = ''
    if (Array.isArray(arr) && arr.length) {
      const candidate = arr[Math.floor(Math.random() * arr.length)]
      try {
        let buffer: Buffer;
        let mime: string;
        // 判断是本地文件还是远程URL
        if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
          // 远程URL
          const res = await fetch(candidate, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36' } })
          if (res.ok) {
            buffer = Buffer.from(await res.arrayBuffer())
            const ext = candidate.split('.').pop()?.toLowerCase() || 'jpg'
            mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
          } else {
            throw new Error(`请求失败: ${res.status}`)
          }
        } else {
          // 本地文件
          buffer = await fs.readFile(candidate)
          const ext = extname(candidate).slice(1).toLowerCase()
          mime = ext === 'png' ? 'image/png' :
            ext === 'gif' ? 'image/gif' :
              ext === 'webp' ? 'image/webp' : 'image/jpeg'
        }
        content = `<image src="base64://${buffer.toString('base64')}" type="${mime}"/>`
      } catch (e) {
        logger.error('图片处理失败:', e)
      }
    }
    return { pattern: m[0], content }
  }))
  return replacements.reduce((result, { pattern, content }) => result.replace(pattern, content), template)
}