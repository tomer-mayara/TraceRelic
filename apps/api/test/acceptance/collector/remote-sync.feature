@lc15
Feature: Resume a remote upload
  Scenario Outline: Restart the scanner after losing the connection during an upload
    Given the collector API holds a 120-token call and my transcript has another call of 30
    When the connection drops <moment> and I restart the scanner against the same API
    Then an authenticated read returns two calls totaling 150 and a checkpoint covering both

    Examples:
      | moment                             |
      | before the API receives the upload |
      | after the API accepts the upload   |
