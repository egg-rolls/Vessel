/**
 * Hub 节点 URL 归一化。
 *
 * 规则与 gateway 监听一致：http(s)、非回环必须 https、禁止 path/query/hash/userinfo。
 */

import { isLoopbackHostname } from '../../packages/config/src/index';

/** 校验并归一化节点 URL；非法输入抛错，错误信息不含凭据。 */
export function normalizeNodeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid node url "${raw}": expected an absolute http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid node url "${raw}": must use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`invalid node url "${raw}": must not contain userinfo`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`invalid node url "${raw}": must not contain a path`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`invalid node url "${raw}": must not contain query or hash`);
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== 'https:') {
    throw new Error(`invalid node url "${raw}": non-loopback nodes must use https`);
  }
  return url.origin;
}
