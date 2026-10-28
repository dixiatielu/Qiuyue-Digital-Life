# Allow delayed understanding and preserve perception gaps during recovery

A single primary thinking process may not keep up with group message volume. Received events may therefore be saved and read in batches, and model calls paused when configured usage limits are reached, while events continue to be received and saved. After reconnection, attempt to retrieve history and record any portion that cannot be confirmed complete as a perception gap, so incomplete observations are not mistaken for complete experiences. The same Agent reassesses whether expired activities and backlogged matters are still meaningful; it does not mechanically execute every expired activity.

For technical background, see the [SnowLuma recovery boundary review](../research/snowluma-recovery.md). This decision does not promise recovery of every type of event during disconnection.
