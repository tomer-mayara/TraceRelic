This function exceeds the code line limit for its file type. Tests and scripts have a higher limit so a reader can follow a complete scenario.

Look for work that has a distinct purpose and a clear name. Keep setup, actions, and assertions together when their order explains the behavior.

{% for issue in issues %}
{{ issue.details.file }}:{{ issue.details.line }}
{{ issue.details.message }}
{% endfor %}
