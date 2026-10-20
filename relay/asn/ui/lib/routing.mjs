// 來信歸屬：from_node／from_agent 對到哪個好友；對不到就要新增一列。純函式。
import { friendId } from './roster.mjs'

const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/

export function routeMail(friendsById, mail) {
  const node = NODE_RE.test(String(mail?.from_node ?? '')) ? mail.from_node : '?'
  const agent = typeof mail?.from_agent === 'string' ? mail.from_agent : ''
  const id = friendId(node, agent)
  const hit = friendsById.get ? friendsById.get(id) : friendsById[id]
  return { id, node, agent, isNew: !hit }
}

// 新增好友（來信對不到名單時）
export const stubFriend = ({ id, node, agent }) => ({ id, node, agent, nick: agent || node, psm: agent ? '' : '總機', engine: null, status: 'offline' })
