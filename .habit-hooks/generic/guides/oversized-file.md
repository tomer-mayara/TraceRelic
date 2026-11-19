This file exceeds the limit of 500 code lines. Blank lines and comment-only lines are excluded.

Look for responsibilities that change independently. Split them when that makes the file easier to understand. If the code belongs together, explain why in the review.

{% for issue in issues %}
{{ issue.details.file }}
{{ issue.details.message }}
{% endfor %}
