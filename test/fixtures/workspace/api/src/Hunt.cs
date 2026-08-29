namespace Fixture.Api;

public sealed class Hunt
{
    public Guid Id { get; init; }
    public string Title { get; init; } = "";

    public void Complete()
    {
        // Emits HuntCompleted.
    }
}
