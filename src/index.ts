import { Context, Schema, h } from 'koishi'
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

const tableName = 'picar_images'
const tagTableName = 'picar_tags'

// 定义数据库表结构
declare module 'koishi' {
  interface Tables {
    picar_images: PicarImage
    picar_tags: PicarTag
  }
}

export interface PicarImage {
  id: number
  tag: string
  img_url: string
  uploader: string
  uploaderId: number
  upload_time: Date
}

export interface PicarTag {
  id: number
  tag: string
}

export function apply(ctx: Context, config: any) {
  // 扩展数据库表结构（如果表不存在会自动创建）
  ctx.model.extend(tableName, {
    id: 'unsigned',
    tag: 'string',
    img_url: 'text',
    uploader: 'string', 
    uploaderId: 'unsigned',
    upload_time: 'timestamp',
  }, {
    autoInc: true,
  })

  // 扩展标签表
  ctx.model.extend(tagTableName, {
    id: 'unsigned',
    tag: {
      type: 'string',
      unique: true,  // 标签唯一
    },
  }, {
    autoInc: true,
  })

   ctx.command('好图', '显示好图命令的帮助页面')
    .action(() => {
      return `好图命令帮助页面：
- 好图 随机 <标签名>：随机获取一张指定标签的图片
- 好图 看 <标签名> [页码]：查看某标签下的所有图片
- 好图 列表：列出所有图片标签
- 好图 添加 <标签名>：添加图片到指定标签
- 好图 帮助：显示此帮助页面`;
    });

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

  ctx.command('好图.随机 <arg1>', '随机获取一张好图')
    .action(async (argv, arg1) => {
      var condition = arg1 && `${arg1}`.trim() !== '' && !arg1.startsWith('<') 
        ? { tag: arg1 } 
        : {}

      const rows = await ctx.database.get(tableName, condition, ['img_url'])
      if (rows.length === 0) {
        return `没有找到图片，请先添加图片`
      }

      const randomIndex = Math.floor(Math.random() * rows.length)
      const imgUrl = rows[randomIndex].img_url

      return `<image src="${imgUrl}"/>`
    })

  ctx.command('好图.看 <arg1> [page]', '列出某标签下的所有好图')
    .action(async (argv, arg1, page) => {
      if (!arg1 || `${arg1}`.trim() === '' || arg1.startsWith('<')) {
        return `你是坏图，请使用 "好图 看 &lt;标签名&gt; [页码]"`
      }

      const rows = await ctx.database.get(tableName, { tag: arg1 }, ['img_url'])
      if (rows.length === 0) {
        return `标签 ${arg1} 下没有图片，请先添加图片`
      }

      const pageSize = 10
      const pageNum = Math.max(1, parseInt(page as any) || 1)
      const totalPages = Math.ceil(rows.length / pageSize)
      
      if (pageNum > totalPages) {
        return `页码 ${pageNum} 超出范围，共 ${totalPages} 页`
      }

      const startIndex = (pageNum - 1) * pageSize
      const endIndex = startIndex + pageSize
      const paginatedRows = rows.slice(startIndex, endIndex)

      let session = argv.session

      const messages = paginatedRows.map((row, index) => 
        h('message', {}, [
          h('author', { id: session.userId, nickname: session.username }),
          h.image(row.img_url),
          // h.text(`图片 ${startIndex + index + 1}/${rows.length}`)
        ])
      )

      const pageInfo = `\n【第 ${pageNum}/${totalPages} 页，共 ${rows.length} 张图片】\n${pageNum < totalPages ? `查看下一页：好图 看 ${arg1} ${pageNum + 1}` : '已是最后一页'}`
      messages.push(h('message', {}, [
        h('author', { id: session.userId, nickname: session.username }),
        h.text(pageInfo)
      ]))

      return h('message', { forward: true }, messages)
    })

  ctx.command('好图.列表', '列出所有好图标签')
    .action(async (argv) => {
      const rows = await await ctx.database.get(tagTableName, {}, ['tag'])
      const distinctTags = Array.from(new Set(rows.map(row => row.tag)))
      if (rows.length === 0) {
        return `当前没有任何好图，请先添加图片`
      }

      const tagSet = new Set<string>()
      for (let row of rows) {
        tagSet.add(row.tag)
      }

      let msg = `当前所有好图标签：\n`
      for (let tag of tagSet) {
        msg += `- ${tag}\n`
      }

      return msg
    })

  ctx.command('好图.添加 <arg1>', '什么 有好图 快收！')
    .action(async (argv, arg1) => {
      if (!arg1 || `${arg1}`.trim() === '' || arg1.startsWith('<')) {
        return `你是坏图，请使用 "好图 添加 &lt;标签名&gt;"`
      }

      // ctx.logger.info(`argv 结构:`, JSON.stringify(argv, null, 2))
      let quote = argv.session.quote
      let imgs = []
      if (quote) {
        for (let element of quote.elements) {
          if (element.type === 'img') {
            imgs.push(element.attrs.src)
          }
        }
      }
      for (let element of argv.session.elements) {
        if (element.type === 'img') {
          imgs.push(element.attrs.src)
          ctx.logger.info(`检测到图片: ${element.attrs.src}`)
        }
      }

      if (imgs.length === 0) {
        return '未检测到图片，请发送图片或引用包含图片的消息'
      }

      // 检查标签是否存在，不存在则插入
      const existingTags = await ctx.database.get(tagTableName, { tag: arg1 })
      if (existingTags.length === 0) {
        await ctx.database.create(tagTableName, { tag: arg1 })
        ctx.logger.info(`新增标签: ${arg1}`)
      }

      // 批量插入图片
    const uploader = argv.session.username || '未知用户'
    const uploaderId = Number(argv.session.userId) || 0
    const uploadTime = new Date()
    await ctx.database.upsert(tableName, imgs.map(url => ({
      tag: arg1,
      img_url: url,
      uploader,
      uploaderId: Number(uploaderId),
      upload_time: uploadTime,
    })))

      const msg = `好图已加入 ${arg1}，共 ${imgs.length} 张图片`
      return msg
    })

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