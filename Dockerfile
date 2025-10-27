# Use an official Python runtime as a parent image
FROM python:3.10-slim

# Set the working directory inside the container
WORKDIR /app

# Copy the requirements file first to leverage Docker cache
COPY requirements.txt .

# Install any needed packages specified in requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire 'backend' directory into the container at /app/backend
COPY ./backend ./backend

# Make port 8000 available to the world outside this container
EXPOSE 8000

# Define the command to run your app
# We run the app from the 'backend' package's 'main' module
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
