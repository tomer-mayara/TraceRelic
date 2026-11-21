@lc15
Feature: Resume a remote upload
  Scenario Outline: Restart the scanner after losing the connection during an upload
    Given the collector API holds a 120-token call and my transcript has another call of 30
    When the connection drops <moment> and I restart the scanner against the same API
    Then an authenticated read returns two calls totaling 150 and a checkpoint covering both
    And the interrupted scan logs its pending report as a warning on standard error

    Examples:
      | moment                             |
      | before the API receives the upload |
      | after the API accepts the upload   |

  Scenario: A restarted scanner resumes a long sequence of small provider calls
    Given a transcript containing 2800 distinct small Codex calls
    When I upload the transcript and restart the scanner to append one more call
    Then the remote session contains 2801 calls and each request fits in one MiB
    And the one-call append needs one upload smaller than 64 KiB

  Scenario Outline: Both spellings of the same authenticated installation select one source
    Given I uploaded one transcript with the installation <first>
    When I scan again with the installation <second> and then remove the transcript
    Then one checkpoint and one disappearance identify the transcript
    And the scan logs the missing source as a warning and writes the sessions as JSON to standard output

    Examples:
      | first   | second  |
      | omitted | named   |
      | named   | omitted |
