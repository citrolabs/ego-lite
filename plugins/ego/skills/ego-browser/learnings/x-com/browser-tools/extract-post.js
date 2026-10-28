async function(args) {
  const el = document.querySelector('[data-testid="tweet"]:focus') || document.querySelector('[data-testid="tweet"]');
  if (!el) return { error: 'no active tweet found' };
  return {
    text: el.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || '',
    author: el.querySelector('[data-testid="User-Name"] span')?.innerText?.trim() || '',
    timestamp: el.querySelector('time')?.getAttribute('datetime') || '',
  };
}
