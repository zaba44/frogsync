using System.Buffers.Binary;

namespace FrogSync.Server.StartPage;

/// <summary>
/// Kontrola kontenera obrazu i wymiarow, bez dekodowania pikseli.
/// SVG i typ MIME niezgodny z bajtami sa odrzucane.
/// </summary>
internal static class StartPageImage
{
    public static void Validate(ReadOnlySpan<byte> bytes, string? contentType)
    {
        var dimensions = contentType switch
        {
            "image/png" => Png(bytes),
            "image/jpeg" => Jpeg(bytes),
            "image/webp" => WebP(bytes),
            _ => throw Bad(),
        };

        if (dimensions.Width is < 1 or > 4096 ||
            dimensions.Height is < 1 or > 4096 ||
            (long)dimensions.Width * dimensions.Height > 16_777_216)
            throw new ArgumentException("Logo musi miec wymiary od 1 do 4096 pikseli.");

        // Bajty sa pozniej podawane tylko z ustalonym typem image/* i nosniff.
    }

    private static (int Width, int Height) Png(ReadOnlySpan<byte> b)
    {
        ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];

        if (b.Length < 33 || !b[..8].SequenceEqual(signature))
            throw Bad();

        var p = 8;
        var width = 0;
        var height = 0;
        var imageData = false;

        while (p <= b.Length - 12)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(b.Slice(p, 4));

            if (length > (uint)(b.Length - p - 12))
                throw Bad();

            var size = (int)length;
            var kind = b.Slice(p + 4, 4);
            var data = b.Slice(p + 8, size);

            if (p == 8)
            {
                if (!kind.SequenceEqual("IHDR"u8) || size != 13)
                    throw Bad();

                var w = BinaryPrimitives.ReadUInt32BigEndian(data[..4]);
                var h = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(4, 4));

                if (w > 4096 || h > 4096)
                    throw Bad();

                width = (int)w;
                height = (int)h;

                if (data[10] != 0 || data[11] != 0 || data[12] > 1)
                    throw Bad();
            }
            else if (kind.SequenceEqual("IHDR"u8))
            {
                throw Bad();
            }

            if (kind.SequenceEqual("IDAT"u8) && size > 0)
                imageData = true;

            p += size + 12;

            if (kind.SequenceEqual("IEND"u8))
            {
                if (size != 0 || p != b.Length || !imageData)
                    throw Bad();

                return (width, height);
            }
        }

        throw Bad();
    }

    private static (int Width, int Height) Jpeg(ReadOnlySpan<byte> b)
    {
        if (b.Length < 4 || b[0] != 0xff || b[1] != 0xd8 ||
            b[^2] != 0xff || b[^1] != 0xd9)
            throw Bad();

        var p = 2;
        var width = 0;
        var height = 0;

        while (p < b.Length - 2)
        {
            if (b[p++] != 0xff)
                throw Bad();

            while (p < b.Length && b[p] == 0xff)
                p++;

            if (p >= b.Length)
                throw Bad();

            var marker = b[p++];

            if (marker == 0 || marker is 0xd8 or 0xd9)
                throw Bad();

            if (marker == 1 || marker is >= 0xd0 and <= 0xd7)
                continue;

            if (p > b.Length - 2)
                throw Bad();

            var length = BinaryPrimitives.ReadUInt16BigEndian(b.Slice(p, 2));

            if (length < 2 || p + length > b.Length - 2)
                throw Bad();

            var isFrame = marker is >= 0xc0 and <= 0xcf
                && marker is not (0xc4 or 0xc8 or 0xcc);

            if (isFrame)
            {
                if (length < 8)
                    throw Bad();

                height = BinaryPrimitives.ReadUInt16BigEndian(b.Slice(p + 3, 2));
                width = BinaryPrimitives.ReadUInt16BigEndian(b.Slice(p + 5, 2));
            }

            if (marker == 0xda)
            {
                if (length < 6 || width == 0 || height == 0 ||
                    p + length >= b.Length - 2)
                    throw Bad();

                return (width, height);
            }

            p += length;
        }

        throw Bad();
    }

    private static (int Width, int Height) WebP(ReadOnlySpan<byte> b)
    {
        if (b.Length < 20 || !b[..4].SequenceEqual("RIFF"u8) ||
            !b.Slice(8, 4).SequenceEqual("WEBP"u8) ||
            BinaryPrimitives.ReadUInt32LittleEndian(b.Slice(4, 4)) != b.Length - 8L)
            throw Bad();

        var p = 12;
        var width = 0;
        var height = 0;
        var imageData = false;

        while (p <= b.Length - 8)
        {
            var kind = b.Slice(p, 4);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(b.Slice(p + 4, 4));

            if (length > (uint)(b.Length - p - 8))
                throw Bad();

            var size = (int)length;
            var data = b.Slice(p + 8, size);

            if (kind.SequenceEqual("VP8 "u8))
            {
                if (size < 10 || (data[0] & 1) != 0 ||
                    !data.Slice(3, 3).SequenceEqual(new byte[] { 0x9d, 0x01, 0x2a }))
                    throw Bad();

                width = BinaryPrimitives.ReadUInt16LittleEndian(data.Slice(6, 2)) & 0x3fff;
                height = BinaryPrimitives.ReadUInt16LittleEndian(data.Slice(8, 2)) & 0x3fff;
                imageData = true;
            }
            else if (kind.SequenceEqual("VP8L"u8))
            {
                if (size < 5 || data[0] != 0x2f)
                    throw Bad();

                var bits = BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(1, 4));

                if ((bits >> 29) != 0)
                    throw Bad();

                width = (int)(bits & 0x3fff) + 1;
                height = (int)((bits >> 14) & 0x3fff) + 1;
                imageData = true;
            }
            else if (kind.SequenceEqual("VP8X"u8))
            {
                if (size != 10)
                    throw Bad();

                var canvasWidth = 1 + data[4] + (data[5] << 8) + (data[6] << 16);
                var canvasHeight = 1 + data[7] + (data[8] << 8) + (data[9] << 16);

                if (canvasWidth > 4096 || canvasHeight > 4096)
                    throw Bad();
            }

            p += 8 + size + (size & 1);

            if (p > b.Length)
                throw Bad();
        }

        if (p != b.Length || !imageData)
            throw Bad();

        return (width, height);
    }

    private static ArgumentException Bad() =>
        new("Niepoprawny obraz PNG/JPEG/WebP, niezgodny typ albo zbyt duze wymiary.");
}
