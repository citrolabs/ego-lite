async function(args) {
  const suggestionEls = document.querySelectorAll('span.gsqphr');
  if (suggestionEls.length) {
    return [...suggestionEls].map(el => el.innerText?.trim() || '').filter(Boolean);
  }
  const lis = document.querySelectorAll('.ssb-a');
  if (lis.length) {
    return [...lis].map(li => li.innerText?.trim() || '').filter(Boolean);
  }
  return [];
}
