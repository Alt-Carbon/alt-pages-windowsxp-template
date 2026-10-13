---
title: A website you keep when you leave
date: 2026-08-11
blurb: Why every colleague should own their site, account and all.
---
Most company profile pages are rented. They live on the company's domain, in the company's system, and they vanish the week you hand in your laptop. Years of talks, papers and projects go with them.

We are trying something different. Every colleague gets a personal website on day one. The code sits in their own GitHub account and the hosting in their own Cloudflare account. The company supplies the template, the editor and a subdomain, and nothing the site needs to run.[^1]

The test is simple. Cut every company service and the site should still build, still serve, and still be editable. If that holds, then leaving the company is a permissions change, not a migration.

It also changes how people write. A page you will keep is worth more care than a page you will lose. People put their real work on it.

The cost to the company is small: a template, a few Workers, and the discipline to never put anything important on our side of the line.

[^1]: The subdomain is the one thing that does not survive. It redirects to the person's own domain for ninety days, then goes away.
