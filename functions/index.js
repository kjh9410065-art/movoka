// 홈페이지는 기존 정적 HTML을 그대로 제공하면서 실시간 영화 데이터 스크립트만 추가합니다.
export async function onRequest(context) {
  const response = await context.env.ASSETS.fetch(context.request);

  // Pages Functions의 HTMLRewriter로 기존 페이지의 body 끝에 라이브 기능을 주입합니다.
  return new HTMLRewriter()
    .on('body', {
      element(element) {
        element.append('<script src="/movoka-live.js" defer></script>', { html: true });
      }
    })
    .transform(response);
}
