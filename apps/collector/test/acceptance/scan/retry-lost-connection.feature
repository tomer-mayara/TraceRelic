@lc08
Feature: Sync after a lost connection
  Scenario Outline: The collector loses its connection during a 30-token upload
    Given storage holds a 120-token call and the source contains one more call of 30
    When the connection drops <moment> and I scan again after reconnecting
    Then I can read two calls totaling 150 and the checkpoint is at the end of the new call

    Examples:
      | moment                |
      | before storage writes |
      | after storage writes  |
