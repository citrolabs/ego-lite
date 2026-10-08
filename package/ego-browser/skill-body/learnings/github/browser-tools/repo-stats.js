async function(args) {
  const stats = {
    stars: document.querySelector('a[href*="stargazers"]')?.innerText?.replace(/\s/g, '') || '',
    forks: document.querySelector('a[href*="forks"]')?.innerText?.replace(/\s/g, '') || '',
    language: document.querySelector('[itemprop="programmingLanguage"]')?.innerText?.trim() || '',
    name: document.querySelector('[data-target="repo-banner.repoName"]')?.innerText?.trim() || '',
    description: document.querySelector('[data-testid="about-section-notice-p"]')?.nextElementSibling?.innerText?.trim() || '',
  };
  return stats;
}
