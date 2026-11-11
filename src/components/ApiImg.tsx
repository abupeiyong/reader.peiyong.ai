import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { apiBlobUrl } from "../api";
import { IS_HADI } from "../hadi";

/**
 * 要登录才取得到的图片(书的封面)。网页端就是普通 <img>,cookie 自己会带上;
 * Hadi 小程序里 <img> 带不了 Authorization 头,先取成 blob 再显示(见 apiBlobUrl)。
 */
export default function ApiImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_HADI) return;
    let live = true;
    setBlobUrl(null);
    apiBlobUrl(src)
      .then((url) => live && setBlobUrl(url))
      .catch(() => {}); // 取不到就不显示,和 <img> 加载失败一个效果
    return () => {
      live = false;
    };
  }, [src]);

  const shown = IS_HADI ? blobUrl : src;
  if (!shown) return null;
  return <img {...rest} src={shown} />;
}
