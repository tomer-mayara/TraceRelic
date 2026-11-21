Feature: Read a diagnostic and find the calling line

  @log00a
  Scenario: Print an error message to the console
    Given a default console logger
    When the application calls logger.error("message")
    Then standard error contains exactly one log line with the label "ERROR" and the message "message"

  @log00b
  Scenario: Write an error message to a local file
    Given a local file logger for a new temporary log file
    When the application calls logger.error("message")
    And the application waits for the logger to close
    Then the file contains exactly one JSON line with level "error" and message "message"
    And standard output and standard error are empty

  Scenario Outline: Read the caller and the time of a warning
    Given a command runs on <runtime> and sends diagnostics to <destination>
    When the command reports "History file skipped"
    Then <destination> contains one warning with the message "History file skipped"
    And it identifies "jobs/internal/logger.ts" at line 10
    And its UTC timestamp falls between the start and end of the logging call

    @log01
    Examples: Console
      | runtime                                  | destination |
      | Bun running TypeScript                   | the console |
      | Node running JavaScript with source maps | the console |

    @log02
    Examples: File
      | runtime                                  | destination    |
      | Bun running TypeScript                   | the local file |
      | Node running JavaScript with source maps | the local file |

  @log01
  Scenario: Read the command result and the console warning
    Given a command prints the JSON result "[]"
    When it also reports the warning "History file skipped" to the console
    Then standard output equals "[]" followed by one line ending
    And standard error contains exactly one warning

  @log01
  Scenario: Find a call in a build without source maps
    Given a compiled command runs without source maps
    When the command reports "Read failed"
    Then the entry identifies "dist/scan.js" at line 3

  @log02
  Scenario: Reopen a log file and finish pending writes
    Given a previous logger wrote "Earlier" and closed the file
    When a new logger writes "First" and "Second" to that path and closes
    Then the file contains three JSON entries with messages "Earlier", "First", and "Second" in that order

  @log02
  Scenario Outline: Reject an empty path when constructing a logger
    When the application constructs <logger> with an empty <option>
    Then construction throws a TypeError for that path

    Examples:
      | logger           | option     |
      | a console logger | sourceRoot |
      | a file logger    | sourceRoot |
      | a file logger    | filePath   |

  @log03 @log-levels
  Scenario Outline: Show the levels selected for a destination
    Given <destination> uses <setting>
    When the application calls debug, info, warn, and error with only a message
    Then <destination> contains exactly <levels> in that order

    Examples:
      | destination    | setting                          | levels                   |
      | the console    | the default minimum              | info, warn, error        |
      | the console    | a minimum level of warn          | warn, error              |
      | the console    | a minimum level of LogLevel.Warn | warn, error              |
      | the console    | a minimum level of debug         | debug, info, warn, error |
      | the local file | a minimum level of warn          | warn, error              |
      | the local file | a minimum level of LogLevel.Warn | warn, error              |
      | the local file | a minimum level of debug         | debug, info, warn, error |

  @log03
  Scenario Outline: Change the minimum level on a running logger
    Given a logger for <destination> with a minimum level of info
    When the application logs "before" at info level
    And it calls logger.setLogLevel(LogLevel.Error)
    And it logs "quiet" at warn level and "failure" at error level
    And it calls logger.setLogLevel(LogLevel.Debug) on the same logger
    And it logs "details" at debug level
    Then <destination> contains exactly "before", "failure", and "details" in that order

    Examples:
      | destination    |
      | the console    |
      | the local file |

  @log03
  Scenario Outline: Use the constructor threshold for the first message
    Given <destination> is constructed with a minimum level of warn
    When the application calls debug, info, warn, and error with only a message
    Then <destination> contains exactly warn, error in that order

    Examples:
      | destination    |
      | the console    |
      | the local file |

  @log04
  Scenario Outline: Keep a multiline message in one entry
    Given diagnostics go to <destination>
    When the application logs this message
      """
      Could not read "history".
      Retry in C:\logs.
      """
    Then <destination> contains exactly one physical line
    And <result>

    Examples:
      | destination    | result                                                         |
      | the console    | the console shows both parts with the line break written as text |
      | the local file | the decoded JSON message equals the input text                  |

  @log05
  Scenario Outline: Report a missing caller and keep accepted entries
    Given the file logger has accepted "First"
    And the next call has <available frames>
    When the application reports "Missing" and closes the logger
    Then close reports that the calling file and line are unavailable
    And the file contains exactly one entry with the message "First"

    Examples:
      | available frames             |
      | an empty stack               |
      | only the logger's own frames |

  @log06
  Scenario Outline: Report a destination failure on close
    Given <destination failure>
    When the application reports a warning and waits for the logger to close
    Then close reports <error> to the caller

    Examples:
      | destination failure                                 | error                               |
      | the selected log file path is an existing directory | a file error with the selected path |
      | the reader of the standard error pipe has closed    | a standard error write failure      |

  @log06
  Scenario: Close a console logger while its command continues
    Given a console logger has accepted "Last warning"
    When the command starts closing it twice and tries to log "Late"
    Then the late call throws an error that says the logger is closed
    And both close calls finish after "Last warning" is written
    And the command can still write "Done" to standard error

  @log07
  Scenario: Give each console level a different color
    Given standard error is a terminal with color enabled
    When a console logger set to debug logs one message at each level
    Then only the level labels have the following foreground colors
      | label | color  |
      | DEBUG | cyan   |
      | INFO  | green  |
      | WARN  | yellow |
      | ERROR | red    |

  @log07
  Scenario Outline: Read a plain console line
    Given <output setting>
    And a default console logger
    When the application calls logger.error("message")
    Then standard error contains exactly one log line with the label "ERROR" and the message "message"

    Examples:
      | output setting                                          |
      | standard error goes to a pipe                           |
      | standard error is a terminal and NO_COLOR is set to "1" |

  @log-levels
  Scenario: Read the numeric severity of each public log level
    When the application imports the shared logging package
    Then its LogLevel enum has these numeric severities
      | member | severity |
      | Debug  | 2        |
      | Info   | 3        |
      | Warn   | 4        |
      | Error  | 5        |

  @log03
  Scenario: Keep the current threshold after an invalid level
    Given a logger for the local file with a minimum level of info
    When the application calls setLogLevel with the JSON value "6"
    And the application logs "still visible" at info level
    Then the invalid input throws a TypeError
    And the local file contains the single message "still visible"

  @log04
  Scenario Outline: Reject a non-string message
    Given diagnostics go to <destination>
    When the application calls info with the JSON value "{}"
    Then the invalid input throws a TypeError
    And the destination contains no log entries

    Examples:
      | destination    |
      | the console    |
      | the local file |
